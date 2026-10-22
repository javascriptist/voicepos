package local.pos.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.floreantpos.model.ActionHistory;
import com.floreantpos.model.KitchenTicket;
import com.floreantpos.model.MenuItem;
import com.floreantpos.model.MenuItemModifierGroup;
import com.floreantpos.model.MenuModifier;
import com.floreantpos.model.ModifierGroup;
import com.floreantpos.model.OrderType;
import com.floreantpos.model.Printer;
import com.floreantpos.model.ShopTable;
import com.floreantpos.model.Shift;
import com.floreantpos.model.Terminal;
import com.floreantpos.model.Ticket;
import com.floreantpos.model.TicketItem;
import com.floreantpos.model.TicketItemCookingInstruction;
import com.floreantpos.model.TicketItemModifier;
import com.floreantpos.model.User;
import com.floreantpos.model.UserPermission;
import com.floreantpos.model.dao.ShopTableDAO;
import com.floreantpos.model.dao.TicketDAO;
import com.floreantpos.report.ReceiptPrintService;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.logging.Level;
import java.util.logging.Logger;
import javax.print.PrintService;
import javax.print.PrintServiceLookup;
import net.sf.jasperreports.engine.JasperPrint;
import net.sf.jasperreports.engine.JRExporterParameter;
import net.sf.jasperreports.engine.export.JRPrintServiceExporter;
import net.sf.jasperreports.engine.export.JRPrintServiceExporterParameter;
import org.apache.commons.lang.SerializationUtils;
import org.hibernate.LockMode;
import org.hibernate.Session;
import org.hibernate.Transaction;

public final class FloreantBackend implements Backend {
    private static final Logger LOG = Logger.getLogger(FloreantBackend.class.getName());
    private static final String PENDING = "VOICE_API_PENDING_KITCHEN";
    private static final String PENDING_REVISION = "VOICE_API_PENDING_REVISION";
    private static final int MAX_OPERATIONS = 256;
    private final Context context;
    private final KitchenPrinter printer;

    public interface Context {
        boolean initialized();
        Terminal terminal();
        Shift shift();
        List<OrderType> orderTypes();
        boolean priceIncludesTax();
        User user();
        Ticket editedTicket();
    }

    public interface KitchenPrinter {
        void print(KitchenTicket ticket) throws Exception;
        default void validate(KitchenTicket ticket) {}
    }

    private interface Work<T> {
        T run(Session session);
    }

    public FloreantBackend(Context context, KitchenPrinter printer) {
        this.context = context;
        this.printer = printer;
    }

    @Override
    public ObjectNode execute(Request request) throws Exception {
        if ("GET".equals(request.method) && "/v1/health".equals(request.path)) {
            ObjectNode result = Request.JSON.createObjectNode();
            result.put("status", ready() ? "ready" : "not_ready");
            result.put("loggedIn", context.user() != null);
            return result;
        }
        requireReady();
        if ("GET".equals(request.method)) {
            return transaction(session -> read(session, request.path));
        }
        request.operationKey();
        if (request.path.matches("/v1/tickets/[1-9][0-9]*/send")) {
            return send(request, pathId(request.path, 3));
        }
        return transaction(session -> mutate(session, request));
    }

    private boolean ready() {
        return context.initialized() && context.user() != null
                && context.terminal() != null && context.shift() != null;
    }

    private void requireReady() {
        if (!ready()) {
            throw new ApiException(503, "pos_not_ready", "Start POS and log in with an active shift before using the ordering API.");
        }
        if (!context.user().hasPermission(UserPermission.CREATE_TICKET)) {
            throw new ApiException(403, "permission_denied", "The logged-in POS user needs Create Ticket permission.");
        }
    }

    private <T> T transaction(Work<T> work) {
        Session session = TicketDAO.getInstance().createNewSession();
        Transaction transaction = null;
        try {
            transaction = session.beginTransaction();
            T result = work.run(session);
            transaction.commit();
            return result;
        } catch (RuntimeException e) {
            if (transaction != null) {
                try {
                    transaction.rollback();
                } catch (RuntimeException rollbackError) {
                    e.addSuppressed(rollbackError);
                }
            }
            throw e;
        } finally {
            session.close();
        }
    }

    private ObjectNode read(Session session, String path) {
        if ("/v1/capabilities".equals(path)) {
            ObjectNode result = Request.JSON.createObjectNode();
            result.put("pos", "Floreant POS 2.0.1 beta");
            result.putArray("supported").add("table_tab_open_or_reuse").add("append_item_batches")
                    .add("normal_and_extra_modifiers").add("item_cooking_instructions")
                    .add("seat_numbers").add("fractional_quantities").add("native_pricing_and_taxes")
                    .add("explicit_kitchen_dispatch").add("kitchen_display_dispatch")
                    .add("kitchen_ticket_readback").add("idempotent_mutations").add("kitchen_reconciliation");
            result.putArray("unsupported").add("pizza_sections_sizes_crusts").add("modifier_multipliers")
                    .add("miscellaneous_open_price_items").add("remove_or_void_items").add("ticket_wide_instructions")
                    .add("payments_discounts_refunds").add("customer_required_order_types").add("table_transfers")
                    .add("kitchen_dispatch_without_native_station_routes");
            result.putArray("kitchenDeliveryModes").add("printer").add("kitchen_display");
            result.put("requiresLoggedInUser", true);
            result.put("maximumOperationsPerTicket", MAX_OPERATIONS);
            return result;
        }
        if ("/v1/order-types".equals(path)) {
            ObjectNode result = Request.JSON.createObjectNode();
            ArrayNode types = result.putArray("orderTypes");
            for (OrderType type : context.orderTypes()) {
                ObjectNode node = types.addObject();
                node.put("id", type.getId());
                node.put("name", type.getName());
                node.put("tableOrderingSupported", tableOrderType(type));
                node.put("seatNumbersAllowed", Boolean.TRUE.equals(type.isAllowSeatBasedOrder()));
                node.put("kitchenEnabled", Boolean.TRUE.equals(type.isShouldPrintToKitchen()));
            }
            return result;
        }
        if ("/v1/tables".equals(path)) {
            ObjectNode result = Request.JSON.createObjectNode();
            ArrayNode tables = result.putArray("tables");
            for (Object value : session.createCriteria(ShopTable.class).list()) {
                ShopTable table = (ShopTable) value;
                ObjectNode node = tables.addObject();
                node.put("number", table.getTableNumber());
                node.put("disabled", Boolean.TRUE.equals(table.isDisable()));
                node.put("free", Boolean.TRUE.equals(table.isFree()));
                node.put("booked", Boolean.TRUE.equals(table.isBooked()));
                node.put("dirty", Boolean.TRUE.equals(table.isDirty()));
                ArrayNode tabs = node.putArray("openTicketIds");
                for (Ticket ticket : openTickets(session, table.getTableNumber())) {
                    if (accessible(ticket)) {
                        tabs.add(ticket.getId());
                    }
                }
            }
            return result;
        }
        if ("/v1/menu".equals(path)) {
            ObjectNode result = Request.JSON.createObjectNode();
            ArrayNode menu = result.putArray("items");
            for (Object value : session.createCriteria(MenuItem.class).list()) {
                MenuItem item = (MenuItem) value;
                if (visible(item)) {
                    ObjectNode node = menu.addObject();
                    node.put("id", item.getId());
                    node.put("name", item.getDisplayName());
                    node.put("price", money(item.getPrice()));
                    node.put("description", item.getDescription());
                    if (item.getParent() != null) {
                        node.put("groupId", item.getParent().getId());
                        node.put("groupName", item.getParent().getName());
                        if (item.getParent().getParent() != null) {
                            node.put("categoryId", item.getParent().getParent().getId());
                            node.put("categoryName", item.getParent().getParent().getName());
                            node.put("beverage", Boolean.TRUE.equals(item.getParent().getParent().isBeverage()));
                        }
                    }
                    node.put("supported", !Boolean.TRUE.equals(item.isPizzaType()));
                    node.put("fractionalQuantity", Boolean.TRUE.equals(item.isFractionalUnit()));
                    node.put("hasModifiers", item.hasModifiers());
                }
            }
            return result;
        }
        if (path.matches("/v1/menu/[1-9][0-9]*")) {
            MenuItem item = menuItem(session, pathId(path, 3));
            ObjectNode result = Request.JSON.createObjectNode();
            result.put("id", item.getId());
            result.put("name", item.getDisplayName());
            result.put("description", item.getDescription());
            result.put("supported", !Boolean.TRUE.equals(item.isPizzaType()));
            result.put("fractionalQuantity", Boolean.TRUE.equals(item.isFractionalUnit()));
            ArrayNode prices = result.putArray("prices");
            for (OrderType type : context.orderTypes()) {
                ObjectNode price = prices.addObject();
                price.put("orderTypeId", type.getId());
                price.put("unitPrice", money(item.getPriceByOrderType(type)));
            }
            ArrayNode groups = result.putArray("modifierGroups");
            for (MenuItemModifierGroup link : groups(item)) {
                ModifierGroup group = link.getModifierGroup();
                if (!Boolean.TRUE.equals(group.isEnable())) {
                    continue;
                }
                ObjectNode node = groups.addObject();
                node.put("id", link.getId());
                node.put("name", group.getName());
                node.put("minQuantity", minimum(link));
                node.put("maxQuantity", maximum(link));
                node.put("exclusive", Boolean.TRUE.equals(group.isExclusive()));
                ArrayNode modifiers = node.putArray("modifiers");
                for (MenuModifier modifier : modifiers(group)) {
                    ObjectNode option = modifiers.addObject();
                    option.put("id", modifier.getId());
                    option.put("name", modifier.getDisplayName());
                    option.put("supported", !Boolean.TRUE.equals(modifier.isPizzaModifier()));
                    option.put("printsToKitchen", Boolean.TRUE.equals(modifier.isShouldPrintToKitchen()));
                    ArrayNode modifierPrices = option.putArray("prices");
                    for (OrderType type : context.orderTypes()) {
                        ObjectNode price = modifierPrices.addObject();
                        price.put("orderTypeId", type.getId());
                        price.put("normal", money(modifier.getPriceByOrderType(type)));
                        price.put("extra", money(modifier.getExtraPriceByOrderType(type)));
                    }
                }
            }
            return result;
        }
        if (path.matches("/v1/tickets/[1-9][0-9]*/kitchen")) {
            Ticket ticket = ticket(session, pathId(path, 3), false);
            authorize(ticket);
            ObjectNode result = Request.JSON.createObjectNode();
            result.put("ticketId", ticket.getId());
            ArrayNode kitchens = result.putArray("kitchenTickets");
            for (Object value : session.createQuery("from KitchenTicket k where k.ticketId = :id order by k.id")
                    .setInteger("id", ticket.getId()).list()) {
                KitchenTicket kitchen = (KitchenTicket) value;
                ObjectNode node = kitchens.addObject();
                node.put("id", kitchen.getId());
                node.put("status", kitchen.getStatus());
                node.put("sequenceNumber", kitchen.getSequenceNumber());
                ArrayNode tables = node.putArray("tableNumbers");
                for (Integer number : kitchen.getTableNumbers()) {
                    tables.add(number);
                }
                ArrayNode items = node.putArray("items");
                for (com.floreantpos.model.KitchenTicketItem item : kitchen.getTicketItems()) {
                    ObjectNode line = items.addObject();
                    line.put("name", item.getMenuItemName());
                    line.put("quantity", item.getQuantity());
                    line.put("fractionalQuantity", item.getFractionalQuantity());
                    line.put("cookable", Boolean.TRUE.equals(item.isCookable()));
                }
            }
            return result;
        }
        if (path.matches("/v1/tickets/[1-9][0-9]*")) {
            Ticket ticket = ticket(session, pathId(path, 3), false);
            authorize(ticket);
            return result(ticket, false);
        }
        throw new ApiException(404, "not_found", "Unknown API endpoint.");
    }

    private ObjectNode mutate(Session session, Request request) {
        Ticket replay = replay(session, request);
        if (replay != null) {
            return replayResult(replay, request);
        }
        if (request.path.matches("/v1/tables/[1-9][0-9]*/tab")) {
            Request.fields(request.body, "orderTypeId", "guestCount");
            int number = pathId(request.path, 3);
            int typeId = Request.integer(request.body, "orderTypeId", 1, Integer.MAX_VALUE);
            int guests = Request.integer(request.body, "guestCount", 1, 100);
            OrderType type = orderType(typeId);
            if (!tableOrderType(type)) {
                throw new ApiException(422, "unsupported_order_type", "Choose a table order type that does not require customer data.");
            }
            ShopTable table = table(session, number);
            Ticket edited = context.editedTicket();
            if (edited != null && edited.getTableNumbers() != null && edited.getTableNumbers().contains(number)) {
                throw ApiException.conflict("ticket_in_pos_editor", "Finish or leave the POS order editor for this table before API changes.");
            }
            List<Ticket> existing = openTickets(session, number);
            if (existing.size() > 1) {
                throw ApiException.conflict("ambiguous_table_tab", "This table has multiple open tabs. Select a ticket ID instead.");
            }
            Ticket ticket;
            boolean created = existing.isEmpty();
            if (created) {
                if (!Boolean.TRUE.equals(table.isFree()) || Boolean.TRUE.equals(table.isDisable())
                        || Boolean.TRUE.equals(table.isBooked()) || Boolean.TRUE.equals(table.isDirty())) {
                    throw ApiException.conflict("table_unavailable", "Table is occupied, disabled, booked or dirty.");
                }
                ticket = new Ticket();
                ticket.setOrderType(type);
                ticket.setNumberOfGuests(guests);
                ticket.setPriceIncludesTax(context.priceIncludesTax());
                ticket.setTerminal(context.terminal());
                ticket.setOwner(context.user());
                ticket.setShift(context.shift());
                Calendar now = Calendar.getInstance();
                ticket.setCreateDate(now.getTime());
                ticket.setCreationHour(now.get(Calendar.HOUR_OF_DAY));
                ticket.addTable(number);
            } else {
                ticket = existing.get(0);
                authorize(ticket);
                writable(ticket);
                if (!ticket.getOrderType().getId().equals(typeId) || !ticket.getNumberOfGuests().equals(guests)) {
                    throw ApiException.conflict("tab_details_mismatch", "An existing tab has different orderTypeId or guestCount; no details were changed.");
                }
            }
            remember(ticket, request, "done");
            save(session, ticket, created ? ActionHistory.NEW_CHECK : ActionHistory.EDIT_CHECK, "API open/reuse table " + number);
            if (created) {
                ShopTableDAO.getInstance().occupyTables(ticket, session);
            }
            session.flush();
            ObjectNode response = result(ticket, false);
            response.put("created", created);
            recordResult(ticket, request, Request.JSON.createObjectNode().put("created", created));
            return response;
        }
        if (request.path.matches("/v1/tickets/[1-9][0-9]*/items")) {
            Request.fields(request.body, "expectedRevision", "items");
            Ticket ticket = ticket(session, pathId(request.path, 3), true);
            authorize(ticket);
            writable(ticket);
            revision(ticket, request.body);
            JsonNode items = request.body.get("items");
            if (items == null || !items.isArray() || items.size() < 1 || items.size() > 50) {
                throw ApiException.invalid("items must be an array containing 1 to 50 order lines.");
            }
            for (JsonNode line : items) {
                addItem(session, ticket, Request.object(line, "item"));
            }
            ticket.calculatePrice();
            remember(ticket, request, "done");
            save(session, ticket, ActionHistory.EDIT_CHECK, "API append " + items.size() + " order lines");
            session.flush();
            return result(ticket, false);
        }
        if (request.path.matches("/v1/tickets/[1-9][0-9]*/kitchen/reconcile")) {
            Request.fields(request.body, "outcome", "confirmed");
            if (!context.user().isManager() && !context.user().isAdministrator()) {
                throw new ApiException(403, "permission_denied", "Kitchen reconciliation requires a logged-in manager or administrator.");
            }
            if (!request.body.path("confirmed").isBoolean() || !request.body.path("confirmed").booleanValue()) {
                throw ApiException.invalid("confirmed must be true after checking every kitchen station.");
            }
            String outcome = Request.text(request.body, "outcome", 20);
            if (!"delivered".equals(outcome) && !"not_delivered".equals(outcome)) {
                throw ApiException.invalid("outcome must be delivered or not_delivered.");
            }
            Ticket ticket = ticket(session, pathId(request.path, 3), true);
            authorize(ticket);
            editorGuard(ticket);
            String pending = ticket.getProperty(PENDING);
            if (pending == null) {
                throw ApiException.conflict("no_pending_dispatch", "There is no uncertain API kitchen dispatch to reconcile.");
            }
            String originalMarker = ticket.getProperty(pending);
            if (!snapshot(ticket).path("revision").textValue().equals(ticket.getProperty(PENDING_REVISION))) {
                throw ApiException.conflict("dispatch_source_changed", "The POS edited this ticket during uncertain delivery. Restore the original reviewed order before reconciliation.");
            }
            if (originalMarker == null || !originalMarker.matches("[0-9a-f]{64}\\|started")) {
                throw new IllegalStateException("Invalid pending kitchen operation marker");
            }
            List<KitchenTicket> reconciledJobs = new ArrayList<KitchenTicket>();
            if ("delivered".equals(outcome)) {
                reconciledJobs.addAll(KitchenTicket.fromTicket(ticket));
                for (KitchenTicket kitchen : reconciledJobs) {
                    session.saveOrUpdate(kitchen);
                }
            }
            ticket.getProperties().remove(PENDING);
            ticket.getProperties().remove(PENDING_REVISION);
            ticket.addProperty(pending, originalMarker.substring(0, 64) + "|" + ("delivered".equals(outcome) ? "done" : "cancelled"));
            if ("delivered".equals(outcome)) {
                ObjectNode metadata = Request.JSON.createObjectNode().put("delivery", "manager_confirmed_delivered");
                ArrayNode ids = metadata.putArray("kitchenTicketIds");
                session.flush();
                for (KitchenTicket kitchen : reconciledJobs) {
                    ids.add(kitchen.getId());
                }
                ticket.addProperty(pending + "_RESULT", metadata.toString());
            }
            remember(ticket, request, "done");
            save(session, ticket, ActionHistory.EDIT_CHECK, "API kitchen reconciled by manager: " + outcome);
            session.flush();
            return result(ticket, false);
        }
        throw new ApiException(404, "not_found", "Unknown API endpoint.");
    }

    private ObjectNode send(Request request, int id) throws Exception {
        Request.fields(request.body, "expectedRevision", "confirmed", "deliveryMode");
        String deliveryMode = request.body.has("deliveryMode") ? Request.text(request.body, "deliveryMode", 20) : "printer";
        if (!"printer".equals(deliveryMode) && !"kitchen_display".equals(deliveryMode)) {
            throw ApiException.invalid("deliveryMode must be printer or kitchen_display.");
        }
        if (!request.body.path("confirmed").isBoolean() || !request.body.path("confirmed").booleanValue()) {
            throw ApiException.invalid("confirmed must be true after reviewing the order.");
        }
        final List<KitchenTicket> jobs = new ArrayList<KitchenTicket>();
        final Ticket[] generated = new Ticket[1];
        ObjectNode replay = transaction(session -> {
            Ticket previous = replay(session, request);
            if (previous != null) {
                return replayResult(previous, request);
            }
            Ticket ticket = ticket(session, id, true);
            authorize(ticket);
            writable(ticket);
            revision(ticket, request.body);
            if (!Boolean.TRUE.equals(ticket.getOrderType().isShouldPrintToKitchen())) {
                throw ApiException.conflict("kitchen_disabled", "Kitchen dispatch is disabled for this order type.");
            }
            int pendingItems = 0;
            for (TicketItem item : ticket.getTicketItems()) {
                if (Boolean.TRUE.equals(item.isShouldPrintToKitchen()) && !Boolean.TRUE.equals(item.isPrintedToKitchen())) {
                    pendingItems++;
                    List<Printer> routes = item.getPrinters(ticket.getOrderType());
                    if (routes == null || routes.isEmpty()) {
                        throw ApiException.conflict("missing_kitchen_route", "No kitchen printer route for item " + item.getItemId() + ".");
                    }
                }
            }
            if (pendingItems == 0) {
                throw ApiException.conflict("nothing_to_send", "There are no new kitchen-eligible items to send.");
            }
            generated[0] = (Ticket) SerializationUtils.clone(ticket);
            jobs.addAll(KitchenTicket.fromTicket(generated[0]));
            if (jobs.isEmpty()) {
                throw ApiException.conflict("missing_kitchen_route", "Native POS routing produced no kitchen tickets.");
            }
            if (jobs.size() > 64) {
                throw ApiException.conflict("too_many_kitchen_routes", "A single dispatch supports at most 64 kitchen station tickets.");
            }
            if ("kitchen_display".equals(deliveryMode)) {
                return completeDispatch(session, ticket, jobs, generated[0], request, "persisted_to_kitchen_display");
            }
            for (KitchenTicket job : jobs) {
                printer.validate(job);
            }
            remember(ticket, request, "started");
            ticket.addProperty(PENDING, request.operationKey());
            ticket.addProperty(PENDING_REVISION, Request.text(request.body, "expectedRevision", 64));
            session.saveOrUpdate(ticket);
            session.flush();
            return null;
        });
        if (replay != null) {
            return replay;
        }
        try {
            for (KitchenTicket job : jobs) {
                printer.print(job);
            }
            return transaction(session -> {
                Ticket ticket = ticket(session, id, true);
                if (!request.operationKey().equals(ticket.getProperty(PENDING))) {
                    throw ApiException.conflict("dispatch_state_changed", "Kitchen dispatch state changed; a manager must reconcile delivery.");
                }
                revision(ticket, request.body);
                return completeDispatch(session, ticket, jobs, generated[0], request, "submitted_to_configured_printers");
            });
        } catch (Exception e) {
            LOG.log(Level.SEVERE, "Uncertain kitchen dispatch for ticket " + id + "; manager reconciliation required", e);
            throw new ApiException(409, "kitchen_delivery_uncertain",
                    "Kitchen delivery may be partial. Do not retry with a new key. A manager must check all kitchen stations and reconcile ticket " + id + ".");
        }
    }

    private ObjectNode completeDispatch(Session session, Ticket ticket, List<KitchenTicket> jobs,
            Ticket generated, Request request, String delivery) {
        for (KitchenTicket job : jobs) {
            session.saveOrUpdate(job);
        }
        ticket.markPrintedToKitchen();
        ticket.addProperty("KITCHEN_TICKET_NUMBER", generated.getProperty("KITCHEN_TICKET_NUMBER"));
        if (ticket.getProperties() != null) {
            ticket.getProperties().remove(PENDING);
            ticket.getProperties().remove(PENDING_REVISION);
        }
        remember(ticket, request, "done");
        save(session, ticket, ActionHistory.EDIT_CHECK, "API kitchen dispatch (" + delivery + "): " + jobs.size() + " station tickets");
        session.flush();
        ObjectNode response = result(ticket, false);
        ArrayNode ids = response.putArray("kitchenTicketIds");
        for (KitchenTicket job : jobs) {
            ids.add(job.getId());
        }
        response.put("delivery", delivery);
        ObjectNode metadata = Request.JSON.createObjectNode().put("delivery", delivery);
        metadata.set("kitchenTicketIds", ids.deepCopy());
        recordResult(ticket, request, metadata);
        return response;
    }

    static PrintService validatePrinter(KitchenTicket ticket) {
        Printer printer = ticket.getPrinter();
        if (printer == null || printer.getVirtualPrinter() == null || printer.getDeviceName() == null) {
            throw ApiException.conflict("missing_kitchen_printer", "Kitchen route has no configured printer device.");
        }
        PrintService selected = null;
        for (PrintService service : PrintServiceLookup.lookupPrintServices(null, null)) {
            if (printer.getDeviceName().equals(service.getName())) {
                selected = service;
                break;
            }
        }
        if (selected == null) {
            throw ApiException.conflict("missing_kitchen_printer", "Configured kitchen printer is unavailable: " + printer.getDeviceName());
        }
        return selected;
    }

    static void print(KitchenTicket ticket) throws Exception {
        PrintService selected = validatePrinter(ticket);
        JasperPrint output = render(ticket);
        JRPrintServiceExporter exporter = new JRPrintServiceExporter();
        exporter.setParameter(JRExporterParameter.JASPER_PRINT, output);
        exporter.setParameter(JRPrintServiceExporterParameter.PRINT_SERVICE, selected);
        exporter.setParameter(JRPrintServiceExporterParameter.DISPLAY_PAGE_DIALOG, false);
        exporter.setParameter(JRPrintServiceExporterParameter.DISPLAY_PRINT_DIALOG, false);
        exporter.exportReport();
    }

    static JasperPrint render(KitchenTicket ticket) throws Exception {
        Printer printer = ticket.getPrinter();
        JasperPrint output = ReceiptPrintService.createKitchenPrint(printer.getVirtualPrinter().getName(),
                ticket, printer.getDeviceName());
        output.setName("FP_KitchenReceipt_" + ticket.getTicketId() + "_" + ticket.getSequenceNumber());
        output.setProperty(ReceiptPrintService.PROP_PRINTER_NAME, printer.getDeviceName());
        return output;
    }

    private void addItem(Session session, Ticket ticket, ObjectNode line) {
        Request.fields(line, "menuItemId", "quantity", "seatNumber", "modifiers", "instructions");
        MenuItem menu = menuItem(session, Request.integer(line, "menuItemId", 1, Integer.MAX_VALUE));
        if (Boolean.TRUE.equals(menu.isPizzaType())) {
            throw new ApiException(422, "unsupported_item", "Pizza sizes, crusts and sections must be ordered in the POS UI.");
        }
        JsonNode amount = line.get("quantity");
        if (amount == null || !amount.isNumber() || !Double.isFinite(amount.doubleValue())
                || amount.doubleValue() <= 0 || amount.doubleValue() > 100) {
            throw ApiException.invalid("quantity must be a number greater than zero and at most 100.");
        }
        double quantity = amount.doubleValue();
        boolean fractional = Boolean.TRUE.equals(menu.isFractionalUnit());
        if (!fractional && quantity != Math.floor(quantity)) {
            throw ApiException.invalid("This item requires a whole-number quantity.");
        }
        TicketItem item = menu.convertToTicketItem(ticket.getOrderType(), quantity);
        if (!fractional) {
            item.setItemCount((int) quantity);
        }
        item.setTicket(ticket);
        item.setPriceIncludesTax(ticket.isPriceIncludesTax());
        if (line.has("seatNumber")) {
            if (!Boolean.TRUE.equals(ticket.getOrderType().isAllowSeatBasedOrder())) {
                throw ApiException.invalid("Seat numbers are disabled for this order type.");
            }
            item.setSeatNumber(Request.integer(line, "seatNumber", 1, ticket.getNumberOfGuests()));
        }
        addModifiers(item, menu, ticket.getOrderType(), line.get("modifiers"));
        JsonNode instructions = line.get("instructions");
        if (instructions != null) {
            if (!instructions.isArray() || instructions.size() > 10) {
                throw ApiException.invalid("instructions must be an array of at most 10 strings.");
            }
            for (JsonNode instruction : instructions) {
                ObjectNode text = Request.JSON.createObjectNode();
                text.set("instruction", instruction);
                TicketItemCookingInstruction note = new TicketItemCookingInstruction();
                note.setDescription(Request.text(text, "instruction", 200));
                note.setPrintedToKitchen(false);
                item.addCookingInstruction(note);
            }
        }
        if (Boolean.TRUE.equals(menu.isDisableWhenStockAmountIsZero())) {
            double needed = quantity;
            for (TicketItem existing : ticket.getTicketItems()) {
                if (menu.getId().equals(existing.getItemId()) && !Boolean.TRUE.equals(existing.isStockAmountAdjusted())) {
                    needed += Boolean.TRUE.equals(existing.isFractionalUnit()) ? existing.getItemQuantity() : existing.getItemCount();
                }
            }
            if (menu.getStockAmount() == null || menu.getStockAmount() < needed) {
                throw ApiException.conflict("insufficient_stock", "Not enough stock for menu item " + menu.getId() + ".");
            }
        }
        ticket.addToticketItems(item);
    }

    private void addModifiers(TicketItem item, MenuItem menu, OrderType type, JsonNode selections) {
        if (selections != null && (!selections.isArray() || selections.size() > 50)) {
            throw ApiException.invalid("modifiers must be an array of at most 50 selections.");
        }
        Map<Integer, MenuItemModifierGroup> links = new HashMap<Integer, MenuItemModifierGroup>();
        for (MenuItemModifierGroup link : groups(menu)) {
            if (Boolean.TRUE.equals(link.getModifierGroup().isEnable())) {
                links.put(link.getId(), link);
            }
        }
        Map<Integer, Integer> counts = new HashMap<Integer, Integer>();
        Set<String> seen = new HashSet<String>();
        if (selections != null) {
            for (JsonNode selection : selections) {
                ObjectNode node = Request.object(selection, "modifier");
                Request.fields(node, "groupId", "modifierId", "quantity", "type");
                int groupId = Request.integer(node, "groupId", 1, Integer.MAX_VALUE);
                int modifierId = Request.integer(node, "modifierId", 1, Integer.MAX_VALUE);
                int quantity = Request.integer(node, "quantity", 1, 20);
                String modifierType = Request.text(node, "type", 10);
                if (!"normal".equals(modifierType) && !"extra".equals(modifierType)) {
                    throw ApiException.invalid("Modifier type must be normal or extra.");
                }
                if (!seen.add(groupId + ":" + modifierId + ":" + modifierType)) {
                    throw ApiException.invalid("Duplicate modifier selection; use its quantity instead.");
                }
                MenuItemModifierGroup link = links.get(groupId);
                MenuModifier modifier = null;
                if (link != null) {
                    for (MenuModifier option : modifiers(link.getModifierGroup())) {
                        if (option.getId().equals(modifierId)) {
                            modifier = option;
                            break;
                        }
                    }
                }
                if (modifier == null) {
                    throw ApiException.invalid("Modifier " + modifierId + " is not available in group " + groupId + " for this item.");
                }
                if (Boolean.TRUE.equals(modifier.isPizzaModifier())) {
                    throw new ApiException(422, "unsupported_modifier", "Pizza modifiers require the POS UI.");
                }
                modifier.setMenuItemModifierGroup(link);
                boolean extra = "extra".equals(modifierType);
                TicketItemModifier added = item.addTicketItemModifier(modifier, extra);
                added.setUnitPrice(extra ? modifier.getExtraPriceByOrderType(type) : modifier.getPriceByOrderType(type));
                added.setTaxRate(extra ? modifier.getExtraTaxByOrderType(type) : modifier.getTaxByOrderType(type));
                added.setItemCount(quantity * (Boolean.TRUE.equals(item.isFractionalUnit()) ? 1 : item.getItemCount()));
                added.setPriceIncludesTax(item.isPriceIncludesTax());
                counts.put(groupId, counts.containsKey(groupId) ? counts.get(groupId) + quantity : quantity);
            }
        }
        for (MenuItemModifierGroup link : links.values()) {
            int count = counts.containsKey(link.getId()) ? counts.get(link.getId()) : 0;
            int min = minimum(link);
            int max = maximum(link);
            if (count < min || (max > 0 && count > max)
                    || (Boolean.TRUE.equals(link.getModifierGroup().isExclusive()) && count > 1)) {
                throw ApiException.invalid("Modifier group " + link.getId() + " requires " + min
                        + " to " + (max == 0 ? "unlimited" : max) + " selections; respect exclusive groups.");
            }
        }
    }

    private Ticket replay(Session session, Request request) {
        List<?> matches = session.createQuery("from Ticket t where :key in indices(t.properties)")
                .setString("key", request.operationKey()).list();
        if (matches.isEmpty()) {
            return null;
        }
        if (matches.size() != 1) {
            throw new IllegalStateException("Duplicate API operation markers");
        }
        Ticket ticket = (Ticket) matches.get(0);
        authorize(ticket);
        String marker = ticket.getProperty(request.operationKey());
        if (!marker.startsWith(request.digest() + "|")) {
            throw ApiException.conflict("idempotency_key_reused", "This key was used with a different method, path or body.");
        }
        if (!marker.endsWith("|done")) {
            throw ApiException.conflict("operation_not_completed", "This operation is pending or cancelled. Check kitchen delivery before further action.");
        }
        return ticket;
    }

    private void remember(Ticket ticket, Request request, String state) {
        if (ticket.getProperties() == null) {
            ticket.setProperties(new HashMap<String, String>());
        }
        int count = 0;
        for (String key : ticket.getProperties().keySet()) {
            if (key.matches("VOICE_API_[0-9a-f-]{36}")) {
                count++;
            }
        }
        if (!ticket.getProperties().containsKey(request.operationKey()) && count >= MAX_OPERATIONS
                && !request.path.endsWith("/kitchen/reconcile")) {
            throw ApiException.conflict("operation_limit", "This ticket reached the API operation limit. Continue in the POS UI.");
        }
        ticket.addProperty(request.operationKey(), request.digest() + "|" + state);
    }

    private void recordResult(Ticket ticket, Request request, ObjectNode metadata) {
        String json = metadata.toString();
        if (json.length() > 1000) {
            throw new IllegalStateException("API operation result exceeds native property capacity");
        }
        ticket.addProperty(request.operationKey() + "_RESULT", json);
    }

    private ObjectNode replayResult(Ticket ticket, Request request) {
        ObjectNode response = result(ticket, true);
        String stored = ticket.getProperty(request.operationKey() + "_RESULT");
        if (stored != null) {
            try {
                response.setAll(Request.object(Request.JSON.readTree(stored), "operation result"));
            } catch (java.io.IOException e) {
                throw new IllegalStateException("Invalid persisted API result", e);
            }
        }
        return response;
    }

    private void save(Session session, Ticket ticket, String actionName, String description) {
        reserveStock(session, ticket);
        TicketDAO.getInstance().saveOrUpdate(ticket, session);
        ActionHistory history = new ActionHistory();
        history.setActionTime(new Date());
        history.setActionName(actionName);
        history.setDescription(description + "; ticket " + ticket.getId());
        history.setPerformer(context.user());
        session.save(history);
    }

    private void reserveStock(Session session, Ticket ticket) {
        Map<Integer, Double> quantities = new java.util.TreeMap<Integer, Double>();
        for (TicketItem item : ticket.getTicketItems()) {
            if (!Boolean.TRUE.equals(item.isStockAmountAdjusted()) && item.getItemId() != null) {
                double amount = Boolean.TRUE.equals(item.isFractionalUnit()) ? item.getItemQuantity() : item.getItemCount();
                int id = item.getItemId();
                quantities.put(id, quantities.containsKey(id) ? quantities.get(id) + amount : amount);
            }
        }
        for (Map.Entry<Integer, Double> entry : quantities.entrySet()) {
            MenuItem item = (MenuItem) session.get(MenuItem.class, entry.getKey(), LockMode.UPGRADE);
            if (item == null) {
                throw ApiException.conflict("menu_item_removed", "A pending ticket item no longer exists in the menu.");
            }
            double available = item.getStockAmount() == null ? 0 : item.getStockAmount();
            if (Boolean.TRUE.equals(item.isDisableWhenStockAmountIsZero()) && available < entry.getValue()) {
                throw ApiException.conflict("insufficient_stock", "Not enough stock for menu item " + item.getId() + ".");
            }
            if (available > 0) {
                item.setStockAmount(available - entry.getValue());
            }
        }
        // This build's native stock loop stops at the first previously adjusted line.
        // Reserve all new lines atomically, then let the native DAO handle its other effects.
        for (TicketItem item : ticket.getTicketItems()) {
            item.setStockAmountAdjusted(true);
        }
    }

    private Ticket ticket(Session session, int id, boolean lock) {
        Ticket ticket = (Ticket) session.get(Ticket.class, id, lock ? LockMode.UPGRADE : LockMode.NONE);
        if (ticket == null) {
            throw new ApiException(404, "ticket_not_found", "Ticket not found.");
        }
        return ticket;
    }

    private ShopTable table(Session session, int number) {
        List<?> values = session.createQuery("from ShopTable t where t.id = :number").setInteger("number", number).list();
        if (values.isEmpty()) {
            throw new ApiException(404, "table_not_found", "Table number not found.");
        }
        ShopTable table = (ShopTable) values.get(0);
        session.lock(table, LockMode.UPGRADE);
        return table;
    }

    private List<Ticket> openTickets(Session session, int number) {
        List<Ticket> result = new ArrayList<Ticket>();
        for (Object value : session.createQuery("from Ticket t where t.closed = false and t.voided = false").list()) {
            Ticket ticket = (Ticket) value;
            if (ticket.getTableNumbers() != null && ticket.getTableNumbers().contains(number)) {
                result.add(ticket);
            }
        }
        return result;
    }

    private OrderType orderType(int id) {
        for (OrderType type : context.orderTypes()) {
            if (type.getId().equals(id)) {
                return type;
            }
        }
        throw new ApiException(404, "order_type_not_found", "Order type not found.");
    }

    private boolean tableOrderType(OrderType type) {
        return Boolean.TRUE.equals(type.isShowTableSelection()) && !Boolean.TRUE.equals(type.isRequiredCustomerData());
    }

    private boolean accessible(Ticket ticket) {
        return ticket.getOwner() != null && ticket.getOwner().getId().equals(context.user().getId())
                || (Boolean.TRUE.equals(ticket.isClosed()) ? context.user().canViewAllCloseTickets() : context.user().canViewAllOpenTickets());
    }

    private void authorize(Ticket ticket) {
        if (!accessible(ticket)) {
            throw new ApiException(403, "permission_denied", "The POS user cannot access another server's tab.");
        }
    }

    private void editorGuard(Ticket ticket) {
        Ticket edited = context.editedTicket();
        if (edited != null && ticket.getId().equals(edited.getId())) {
            throw ApiException.conflict("ticket_in_pos_editor", "Leave the POS order editor for this ticket before API changes.");
        }
    }

    private void writable(Ticket ticket) {
        if (Boolean.TRUE.equals(ticket.isClosed()) || Boolean.TRUE.equals(ticket.isVoided()) || Boolean.TRUE.equals(ticket.isPaid())) {
            throw ApiException.conflict("ticket_not_open", "Paid, voided or closed tickets cannot be changed.");
        }
        editorGuard(ticket);
        if (ticket.getProperty(PENDING) != null) {
            throw ApiException.conflict("kitchen_delivery_uncertain", "A manager must reconcile the pending kitchen dispatch before changing this tab.");
        }
        if (!tableOrderType(ticket.getOrderType())) {
            throw new ApiException(422, "unsupported_order_type", "This API only edits supported table order types.");
        }
    }

    private MenuItem menuItem(Session session, int id) {
        MenuItem menu = (MenuItem) session.get(MenuItem.class, id);
        if (menu == null || !visible(menu)) {
            throw new ApiException(404, "menu_item_not_found", "Visible menu item not found.");
        }
        return menu;
    }

    private boolean visible(MenuItem item) {
        return Boolean.TRUE.equals(item.isVisible()) && item.getParent() != null
                && Boolean.TRUE.equals(item.getParent().isVisible()) && item.getParent().getParent() != null
                && Boolean.TRUE.equals(item.getParent().getParent().isVisible());
    }

    private List<MenuItemModifierGroup> groups(MenuItem item) {
        return item.getMenuItemModiferGroups() == null ? Collections.<MenuItemModifierGroup>emptyList() : item.getMenuItemModiferGroups();
    }

    private Set<MenuModifier> modifiers(ModifierGroup group) {
        return group.getModifiers() == null ? Collections.<MenuModifier>emptySet() : group.getModifiers();
    }

    private int minimum(MenuItemModifierGroup group) {
        int configured = group.getMinQuantity() == null ? 0 : group.getMinQuantity();
        return Boolean.TRUE.equals(group.getModifierGroup().isRequired()) ? Math.max(1, configured) : configured;
    }

    private int maximum(MenuItemModifierGroup group) {
        return group.getMaxQuantity() == null ? 0 : group.getMaxQuantity();
    }

    private void revision(Ticket ticket, ObjectNode body) {
        String expected = Request.text(body, "expectedRevision", 64);
        if (!expected.equals(snapshot(ticket).path("revision").textValue())) {
            throw ApiException.conflict("stale_ticket", "The tab changed. Read it again and review the latest revision.");
        }
    }

    private ObjectNode result(Ticket ticket, boolean replayed) {
        ObjectNode result = Request.JSON.createObjectNode();
        result.set("ticket", snapshot(ticket));
        result.put("replayed", replayed);
        result.put("kitchenDeliveryUncertain", ticket.getProperty(PENDING) != null);
        return result;
    }

    private ObjectNode snapshot(Ticket ticket) {
        ObjectNode node = Request.JSON.createObjectNode();
        node.put("id", ticket.getId());
        node.put("orderTypeId", ticket.getOrderType().getId());
        node.put("guestCount", ticket.getNumberOfGuests());
        node.put("closed", Boolean.TRUE.equals(ticket.isClosed()));
        node.put("voided", Boolean.TRUE.equals(ticket.isVoided()));
        node.put("paid", Boolean.TRUE.equals(ticket.isPaid()));
        node.put("total", money(ticket.getTotalAmount()));
        node.put("subtotal", money(ticket.getSubtotalAmount()));
        node.put("tax", money(ticket.getTaxAmount()));
        node.put("discount", money(ticket.getDiscountAmount()));
        ArrayNode tables = node.putArray("tableNumbers");
        if (ticket.getTableNumbers() != null) {
            for (Integer number : ticket.getTableNumbers()) {
                tables.add(number);
            }
        }
        ArrayNode items = node.putArray("items");
        for (TicketItem item : ticket.getTicketItems()) {
            ObjectNode line = items.addObject();
            line.put("id", item.getId());
            line.put("menuItemId", item.getItemId());
            line.put("name", item.getName());
            line.put("quantity", Boolean.TRUE.equals(item.isFractionalUnit()) ? item.getItemQuantity() : item.getItemCount());
            line.put("seatNumber", item.getSeatNumber());
            line.put("unitPrice", money(item.getUnitPrice()));
            line.put("total", money(item.getTotalAmount()));
            line.put("kitchenEligible", Boolean.TRUE.equals(item.isShouldPrintToKitchen()));
            line.put("sentToKitchen", Boolean.TRUE.equals(item.isPrintedToKitchen()));
            ArrayNode modifiers = line.putArray("modifiers");
            if (item.getTicketItemModifiers() != null) {
                for (TicketItemModifier modifier : item.getTicketItemModifiers()) {
                    ObjectNode option = modifiers.addObject();
                    option.put("modifierId", modifier.getModifierId());
                    option.put("groupId", modifier.getMenuItemModifierGroupId());
                    option.put("name", modifier.getName());
                    option.put("quantity", modifier.getItemCount());
                    option.put("quantityPerItem", Boolean.TRUE.equals(item.isFractionalUnit()) ? modifier.getItemCount().doubleValue()
                            : modifier.getItemCount().doubleValue() / item.getItemCount());
                    option.put("modifierType", modifier.getModifierType());
                    option.put("unitPrice", money(modifier.getUnitPrice()));
                    option.put("taxRate", modifier.getTaxRate());
                    option.put("sentToKitchen", Boolean.TRUE.equals(modifier.isPrintedToKitchen()));
                    option.put("printsToKitchen", Boolean.TRUE.equals(modifier.isShouldPrintToKitchen()));
                }
            }
            ArrayNode instructions = line.putArray("instructions");
            if (item.getCookingInstructions() != null) {
                for (TicketItemCookingInstruction instruction : item.getCookingInstructions()) {
                    instructions.add(instruction.getDescription());
                }
            }
        }
        node.put("revision", Request.sha256(node.toString()));
        return node;
    }

    private BigDecimal money(double amount) {
        if (!Double.isFinite(amount)) {
            throw new IllegalStateException("POS returned an invalid monetary amount");
        }
        return BigDecimal.valueOf(amount).setScale(2, RoundingMode.HALF_UP);
    }

    private int pathId(String path, int index) {
        try {
            return Integer.parseInt(path.split("/")[index]);
        } catch (NumberFormatException e) {
            throw ApiException.invalid("Path ID exceeds the supported integer range.");
        }
    }
}
