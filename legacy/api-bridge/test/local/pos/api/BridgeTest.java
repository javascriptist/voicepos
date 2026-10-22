package local.pos.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.floreantpos.model.*;
import com.floreantpos.model.dao._RootDAO;
import com.floreantpos.model.dao.TicketDAO;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.UUID;
import org.hibernate.Session;
import org.hibernate.Transaction;
import org.hibernate.cfg.Configuration;

public final class BridgeTest {
    private static final String TOKEN = "test-only-token-not-for-production-123456";
    private static int assertions;
    private final Fixture context = new Fixture();
    private final List<KitchenTicket> printed = new ArrayList<KitchenTicket>();
    private boolean failPrinter;
    private FloreantBackend backend;
    private int itemId;
    private int modifierId;
    private int modifierGroupId;
    private int requiredItemId;
    private int fractionalItemId;
    private org.hibernate.SessionFactory factory;

    public static void main(String[] args) throws Exception {
        BridgeTest test = new BridgeTest();
        try {
            test.transport();
            test.initialize();
            test.orders();
            System.out.println("PASS: " + assertions + " assertions; HTTP transport and native Floreant ordering on an isolated in-memory Derby database.");
        } finally {
            if (test.factory != null) {
                test.factory.close();
            }
        }
    }

    private void transport() throws Exception {
        try (ApiServer server = new ApiServer(0, TOKEN, request -> {
            if ("/v1/fail".equals(request.path)) {
                throw new IOException("Injected backend failure");
            }
            if ("/v1/conflict".equals(request.path)) {
                throw ApiException.conflict("test_conflict", "Test conflict");
            }
            return Request.JSON.createObjectNode().put("ok", true);
        })) {
            server.start();
            check(http(server, "GET", "/v1/health", null, null, null, null) == 401, "authentication required");
            check(http(server, "GET", "/v1/health", TOKEN, null, null, null) == 200, "authenticated health");
            check(http(server, "GET", "/v1/health", TOKEN, null, null, "https://untrusted.example") == 403, "browser origins denied");
            check(http(server, "PUT", "/v1/health", TOKEN, null, null, null) == 405, "HTTP methods restricted");
            check(http(server, "GET", "/v1/health?q=1", TOKEN, null, null, null) == 400, "query parameters rejected");
            check(http(server, "POST", "/v1/test", TOKEN, "{}", null, null) == 400, "idempotency key required");
            check(http(server, "POST", "/v1/test", TOKEN, "{}", "not-a-uuid", null) == 400, "idempotency key validated");
            check(http(server, "POST", "/v1/test", TOKEN, "{\"x\":1,\"x\":2}", key(), null) == 400, "duplicate JSON keys rejected");
            check(http(server, "POST", "/v1/test", TOKEN, "{} {}", key(), null) == 400, "trailing JSON rejected");
            check(http(server, "POST", "/v1/test", TOKEN, "[]", key(), null) == 400, "JSON object required");
            check(http(server, "POST", "/v1/test", TOKEN, "{", key(), null) == 400, "malformed JSON rejected");
            check(http(server, "POST", "/v1/test", TOKEN, "{}", key(), null) == 200, "valid mutation accepted");
            char[] boundary = new char[65526];
            Arrays.fill(boundary, 'x');
            check(http(server, "POST", "/v1/test", TOKEN, "{\"pad\":\"" + new String(boundary) + "\"}", key(), null) == 200, "exact 64 KiB body accepted");
            char[] oversized = new char[65537];
            Arrays.fill(oversized, 'x');
            check(http(server, "POST", "/v1/test", TOKEN, new String(oversized), key(), null) == 413, "exact 64 KiB body limit");
            check(http(server, "GET", "/v1/fail", TOKEN, null, null, null) == 500, "backend errors explicitly surfaced");
            check(http(server, "GET", "/v1/conflict", TOKEN, null, null, null) == 409, "domain errors surfaced");
        }
        expect(400, "invalid_request", () -> {
            ObjectNode body = Request.JSON.createObjectNode().put("quantity", 1.5);
            Request.integer(body, "quantity", 1, 100);
        });
    }

    private int http(ApiServer server, String method, String path, String token, String body, String key, String origin) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.port() + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(3000);
        connection.setReadTimeout(10000);
        if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
        if (key != null) connection.setRequestProperty("Idempotency-Key", key);
        if (origin != null) connection.setRequestProperty("Origin", origin);
        if (body != null) {
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            try (java.io.OutputStream output = connection.getOutputStream()) {
                output.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        int status = connection.getResponseCode();
        try (InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
            JsonNode response = Request.JSON.readTree(bytes.toByteArray());
            check(status < 400 ? response.path("ok").booleanValue() : response.path("error").has("requestId"), "response shape for HTTP " + status);
        } finally {
            connection.disconnect();
        }
        return status;
    }

    private void initialize() throws Exception {
        Configuration configuration = _RootDAO.getNewConfiguration("hibernate.mysql.cfg.xml");
        configuration.setProperty("hibernate.connection.driver_class", "org.apache.derby.jdbc.EmbeddedDriver");
        configuration.setProperty("hibernate.connection.url", "jdbc:derby:memory:voice_api_tests;create=true");
        configuration.setProperty("hibernate.connection.username", "app");
        configuration.setProperty("hibernate.connection.password", "test");
        configuration.setProperty("hibernate.dialect", "org.hibernate.dialect.DerbyDialect");
        configuration.setProperty("hibernate.hbm2ddl.auto", "create-drop");
        configuration.setProperty("hibernate.cache.use_second_level_cache", "false");
        configuration.setProperty("hibernate.connection.provider_class", "org.hibernate.connection.DriverManagerConnectionProvider");
        configuration.setProperty("hibernate.connection.autocommit", "true");
        configuration.setProperty("hibernate.show_sql", "false");
        factory = configuration.buildSessionFactory();
        _RootDAO.setSessionFactory(factory);
        backend = new FloreantBackend(context, ticket -> {
            if (failPrinter) throw new IOException("Injected printer failure");
            printed.add(ticket);
        });
        Session session = TicketDAO.getInstance().createNewSession();
        Transaction tx = session.beginTransaction();
        try {
            UserType userType = new UserType();
            userType.setName("API test server");
            userType.setPermissions(new HashSet<UserPermission>(Arrays.asList(UserPermission.CREATE_TICKET)));
            session.save(UserPermission.CREATE_TICKET);
            session.save(userType);
            context.user = new User();
            context.user.setFirstName("API");
            context.user.setLastName("Test");
            context.user.setPassword(UUID.randomUUID().toString().substring(0, 16));
            context.user.setType(userType);
            session.save(context.user);
            context.terminal = new Terminal();
            context.terminal.setId(1);
            context.terminal.setName("API test terminal");
            session.save(context.terminal);
            context.shift = new Shift();
            context.shift.setName("API test shift");
            session.save(context.shift);
            context.type = new OrderType();
            context.type.setName("DINE IN");
            context.type.setShowTableSelection(true);
            context.type.setAllowSeatBasedOrder(true);
            context.type.setShouldPrintToKitchen(true);
            session.save(context.type);
            for (int i = 1; i <= 3; i++) {
                ShopTable table = new ShopTable(i);
                table.setFree(true);
                table.setServing(false);
                table.setBooked(false);
                table.setDisable(false);
                table.setDirty(false);
                session.save(table);
            }
            DataUpdateInfo data = new DataUpdateInfo();
            data.setLastUpdateTime(new Date());
            session.save(data);
            Restaurant restaurant = new Restaurant();
            restaurant.setId(1);
            restaurant.setName("API test restaurant");
            restaurant.setServiceChargePercentage(0.0);
            session.save(restaurant);
            MenuCategory category = new MenuCategory();
            category.setName("Test food");
            category.setVisible(true);
            session.save(category);
            MenuGroup group = new MenuGroup();
            group.setName("Test mains");
            group.setParent(category);
            group.setVisible(true);
            session.save(group);
            MenuItem item = new MenuItem();
            item.setName("Test burger");
            item.setPrice(10.0);
            item.setParent(group);
            item.setVisible(true);
            item.setDisableWhenStockAmountIsZero(true);
            item.setStockAmount(100.0);
            session.save(item);
            itemId = item.getId();
            ModifierGroup options = new ModifierGroup();
            options.setName("Test extras");
            options.setEnable(true);
            options.setRequired(false);
            session.save(options);
            MenuModifier modifier = new MenuModifier();
            modifier.setName("Test cheese");
            modifier.setPrice(1.0);
            modifier.setExtraPrice(2.0);
            modifier.setShouldPrintToKitchen(true);
            modifier.setModifierGroup(options);
            session.save(modifier);
            modifierId = modifier.getId();
            options.setModifiers(new HashSet<MenuModifier>(Arrays.asList(modifier)));
            MenuItemModifierGroup link = new MenuItemModifierGroup();
            link.setModifierGroup(options);
            link.setMinQuantity(0);
            link.setMaxQuantity(2);
            session.save(link);
            modifierGroupId = link.getId();
            item.setMenuItemModiferGroups(Arrays.asList(link));
            MenuItem required = new MenuItem();
            required.setName("Test mandatory choice");
            required.setPrice(5.0);
            required.setParent(group);
            required.setVisible(true);
            ModifierGroup mandatory = new ModifierGroup();
            mandatory.setName("Required");
            mandatory.setEnable(true);
            mandatory.setRequired(true);
            session.save(mandatory);
            MenuItemModifierGroup mandatoryLink = new MenuItemModifierGroup();
            mandatoryLink.setModifierGroup(mandatory);
            mandatoryLink.setMinQuantity(1);
            mandatoryLink.setMaxQuantity(1);
            session.save(mandatoryLink);
            required.setMenuItemModiferGroups(Arrays.asList(mandatoryLink));
            session.save(required);
            requiredItemId = required.getId();
            Tax tax = new Tax();
            tax.setName("Test 10 percent");
            tax.setRate(10.0);
            session.save(tax);
            TaxGroup taxGroup = new TaxGroup();
            taxGroup.setId("api-test-tax");
            taxGroup.setName("Test tax group");
            taxGroup.setTaxes(Arrays.asList(tax));
            session.save(taxGroup);
            MenuItem fractional = new MenuItem();
            fractional.setName("Test weighed food");
            fractional.setPrice(4.0);
            fractional.setParent(group);
            fractional.setVisible(true);
            fractional.setFractionalUnit(true);
            fractional.setUnitName("kg");
            fractional.setTaxGroup(taxGroup);
            fractional.setDisableWhenStockAmountIsZero(true);
            fractional.setStockAmount(10.0);
            session.save(fractional);
            fractionalItemId = fractional.getId();
            tx.commit();
        } catch (RuntimeException e) {
            tx.rollback();
            throw e;
        } finally {
            session.close();
        }
        java.lang.reflect.Field restaurantField = com.floreantpos.main.Application.class.getDeclaredField("restaurant");
        restaurantField.setAccessible(true);
        restaurantField.set(com.floreantpos.main.Application.getInstance(),
                sessionRestaurant());
        java.lang.reflect.Field terminalField = com.floreantpos.main.Application.class.getDeclaredField("terminal");
        terminalField.setAccessible(true);
        terminalField.set(com.floreantpos.main.Application.getInstance(), context.terminal);
    }

    private Restaurant sessionRestaurant() {
        Session session = TicketDAO.getInstance().createNewSession();
        try {
            return (Restaurant) session.get(Restaurant.class, 1);
        } finally {
            session.close();
        }
    }

    private void orders() throws Exception {
        ObjectNode opened = execute("POST", "/v1/tables/1/tab", key(), tabBody());
        int id = opened.path("ticket").path("id").intValue();
        check(id > 0 && opened.path("created").booleanValue(), "new tab persisted");
        ObjectNode reused = execute("POST", "/v1/tables/1/tab", key(), tabBody());
        check(reused.path("ticket").path("id").intValue() == id && !reused.path("created").booleanValue(), "existing tab reused");
        expect(409, "tab_details_mismatch", () -> execute("POST", "/v1/tables/1/tab", key(), tabBody().put("guestCount", 3)));
        String operation = key();
        ObjectNode body = batch(reused, itemId);
        ObjectNode line = (ObjectNode) body.path("items").get(0);
        line.put("seatNumber", 2);
        line.putArray("instructions").add("No onions").add("Severe nut allergy - tell chef");
        line.putArray("modifiers").addObject().put("groupId", modifierGroupId).put("modifierId", modifierId).put("quantity", 1).put("type", "extra");
        ObjectNode added = execute("POST", "/v1/tickets/" + id + "/items", operation, body);
        check(added.path("ticket").path("items").size() == 1, "batch adds item");
        check(added.path("ticket").path("total").doubleValue() == 12.0, "native extra modifier pricing");
        check(added.path("ticket").path("items").get(0).path("instructions").size() == 2, "cooking instructions persisted");
        check(added.path("ticket").path("items").get(0).path("seatNumber").intValue() == 2, "seat number persisted");
        ObjectNode replay = execute("POST", "/v1/tickets/" + id + "/items", operation, body);
        check(replay.path("replayed").booleanValue() && replay.path("ticket").path("items").size() == 1, "retry does not duplicate items");
        expect(409, "idempotency_key_reused", () -> execute("POST", "/v1/tickets/" + id + "/items", operation, batch(added, itemId)));
        expect(409, "stale_ticket", () -> execute("POST", "/v1/tickets/" + id + "/items", key(), batch(reused, itemId)));
        expect(400, "invalid_request", () -> execute("POST", "/v1/tickets/" + id + "/items", key(), batch(added, requiredItemId)));
        ObjectNode excessiveModifiers = batch(added, itemId);
        ((ObjectNode) excessiveModifiers.path("items").get(0)).putArray("modifiers").addObject()
                .put("groupId", modifierGroupId).put("modifierId", modifierId).put("quantity", 3).put("type", "normal");
        expect(400, "invalid_request", () -> execute("POST", "/v1/tickets/" + id + "/items", key(), excessiveModifiers));
        expect(400, "invalid_request", () -> execute("POST", "/v1/tickets/" + id + "/items", key(), batch(added, itemId).put("price", 0)));
        ObjectNode invalidBatch = batch(added, itemId);
        invalidBatch.withArray("items").addObject().put("menuItemId", 99999).put("quantity", 1);
        expect(404, "menu_item_not_found", () -> execute("POST", "/v1/tickets/" + id + "/items", key(), invalidBatch));
        ObjectNode read = execute("GET", "/v1/tickets/" + id, null, Request.JSON.createObjectNode());
        check(read.path("ticket").path("items").size() == 1, "invalid batch fully rolled back");
        context.edited = new Ticket(id);
        expect(409, "ticket_in_pos_editor", () -> execute("POST", "/v1/tickets/" + id + "/items", key(), batch(read, itemId)));
        context.edited = null;
        expect(409, "missing_kitchen_route", () -> execute("POST", "/v1/tickets/" + id + "/send", key(), sendBody(read)));
        expect(409, "missing_kitchen_route", () -> execute("POST", "/v1/tickets/" + id + "/send", key(), sendBody(read).put("deliveryMode", "kitchen_display")));
        check(printed.isEmpty(), "missing routing never prints or silently marks sent");
        check(execute("GET", "/v1/menu/" + itemId, null, Request.JSON.createObjectNode()).path("modifierGroups").size() == 1, "live modifier catalog");
        check(execute("GET", "/v1/tables", null, Request.JSON.createObjectNode()).path("tables").size() == 3, "table catalog");
        kitchenTests(id, read);
        fractionalTests();
        context.user = null;
        expect(503, "pos_not_ready", () -> execute("GET", "/v1/menu", null, Request.JSON.createObjectNode()));
    }

    private void kitchenTests(int id, ObjectNode initial) throws Exception {
        Session session = TicketDAO.getInstance().createNewSession();
        Transaction tx = session.beginTransaction();
        try {
            VirtualPrinter kitchen = new VirtualPrinter();
            kitchen.setName("API test kitchen");
            kitchen.setType(VirtualPrinter.KITCHEN);
            session.save(kitchen);
            TerminalPrinters route = new TerminalPrinters();
            route.setTerminal(context.terminal);
            route.setVirtualPrinter(kitchen);
            route.setPrinterName("Fake printer - never physical");
            session.save(route);
            tx.commit();
        } finally {
            session.close();
        }
        String operation = key();
        ObjectNode send = sendBody(initial);
        ObjectNode sent = execute("POST", "/v1/tickets/" + id + "/send", operation, send);
        check(printed.size() == 1, "exactly one station printed");
        check(sent.path("kitchenTicketIds").size() == 1, "native kitchen ticket persisted");
        check(sent.path("ticket").path("items").get(0).path("sentToKitchen").booleanValue(), "sent state persisted");
        List<String> names = new ArrayList<String>();
        for (KitchenTicketItem line : printed.get(0).getTicketItems()) names.add(line.getMenuItemName());
        check(names.contains("Test burger") && names.stream().anyMatch(name -> name.contains("Test cheese")), "kitchen includes item and modifier: " + names);
        check(names.stream().anyMatch(name -> name.contains("No onions"))
                && names.stream().anyMatch(name -> name.contains("Severe nut allergy - tell chef")), "kitchen includes every cooking instruction: " + names);
        check(printed.get(0).getTableNumbers().size() == 1 && printed.get(0).getTableNumbers().contains(1), "kitchen ticket has correct table");
        net.sf.jasperreports.engine.JasperPrint rendered = FloreantBackend.render(printed.get(0));
        check(!rendered.getPages().isEmpty(), "native kitchen receipt renders without sending to a physical printer");
        StringBuilder renderedText = new StringBuilder();
        for (Object value : rendered.getPages()) {
            if (!(value instanceof net.sf.jasperreports.engine.JRPrintPage)) {
                throw new AssertionError("Invalid rendered page");
            }
            net.sf.jasperreports.engine.JRPrintPage page = (net.sf.jasperreports.engine.JRPrintPage) value;
            receiptText(page.getElements(), renderedText);
        }
        check(renderedText.toString().contains("No onions") && renderedText.toString().contains("Severe nut allergy - tell chef"),
                "rendered kitchen receipt includes complete instruction text");
        expect(409, "missing_kitchen_printer", () -> FloreantBackend.print(printed.get(0)));
        FloreantBackend restarted = new FloreantBackend(context, ticket -> printed.add(ticket));
        ObjectNode replay = restarted.execute(new Request("POST", "/v1/tickets/" + id + "/send", operation, send));
        check(replay.path("replayed").booleanValue() && printed.size() == 1, "persisted idempotency survives bridge recreation");
        check(replay.path("kitchenTicketIds").equals(sent.path("kitchenTicketIds")) && replay.has("delivery"), "send replay preserves result shape and kitchen IDs");
        expect(409, "nothing_to_send", () -> execute("POST", "/v1/tickets/" + id + "/send", key(), sendBody(sent)));
        ObjectNode later = execute("POST", "/v1/tickets/" + id + "/items", key(), batch(sent, itemId));
        check(stock(itemId) == 98.0, "later append reserves stock once, despite prior adjusted lines");
        String secondKey = key();
        ObjectNode laterSent = execute("POST", "/v1/tickets/" + id + "/send", secondKey, sendBody(later));
        check(printed.size() == 2 && printed.get(1).getTicketItems().size() == 1, "later send includes only the new item");
        check(stock(itemId) == 98.0, "sending does not double-decrement stock");
        ObjectNode failureTab = execute("POST", "/v1/tables/2/tab", key(), tabBody());
        int failureId = failureTab.path("ticket").path("id").intValue();
        ObjectNode failureAdded = execute("POST", "/v1/tickets/" + failureId + "/items", key(), batch(failureTab, itemId));
        String failureKey = key();
        failPrinter = true;
        expect(409, "kitchen_delivery_uncertain", () -> execute("POST", "/v1/tickets/" + failureId + "/send", failureKey, sendBody(failureAdded)));
        ObjectNode uncertain = execute("GET", "/v1/tickets/" + failureId, null, Request.JSON.createObjectNode());
        check(uncertain.path("kitchenDeliveryUncertain").booleanValue(), "uncertain dispatch persisted");
        expect(409, "operation_not_completed", () -> execute("POST", "/v1/tickets/" + failureId + "/send", failureKey, sendBody(failureAdded)));
        expect(409, "kitchen_delivery_uncertain", () -> execute("POST", "/v1/tickets/" + failureId + "/items", key(), batch(uncertain, itemId)));
        ObjectNode reconcile = Request.JSON.createObjectNode().put("outcome", "not_delivered").put("confirmed", true);
        expect(403, "permission_denied", () -> execute("POST", "/v1/tickets/" + failureId + "/kitchen/reconcile", key(), reconcile));
        context.user.getType().getPermissions().add(UserPermission.PERFORM_MANAGER_TASK);
        Session changeSession = TicketDAO.getInstance().createNewSession();
        Transaction change = changeSession.beginTransaction();
        Ticket changedTicket = (Ticket) changeSession.get(Ticket.class, failureId);
        changedTicket.setNumberOfGuests(3);
        change.commit();
        changeSession.close();
        expect(409, "dispatch_source_changed", () -> execute("POST", "/v1/tickets/" + failureId + "/kitchen/reconcile", key(), reconcile));
        Session restoreSession = TicketDAO.getInstance().createNewSession();
        Transaction restore = restoreSession.beginTransaction();
        ((Ticket) restoreSession.get(Ticket.class, failureId)).setNumberOfGuests(2);
        restore.commit();
        restoreSession.close();
        ObjectNode reconciled = execute("POST", "/v1/tickets/" + failureId + "/kitchen/reconcile", key(), reconcile);
        check(!reconciled.path("kitchenDeliveryUncertain").booleanValue(), "manager clears confirmed nondelivery");
        failPrinter = false;
        ObjectNode recovered = execute("POST", "/v1/tickets/" + failureId + "/send", key(), sendBody(reconciled));
        check(recovered.path("ticket").path("items").get(0).path("sentToKitchen").booleanValue(), "send succeeds after explicit reconciliation");
        check(laterSent.path("ticket").path("items").size() == 2, "earlier tab still contains both item batches");
        ObjectNode onceMore = execute("POST", "/v1/tickets/" + failureId + "/items", key(), batch(recovered, itemId));
        String deliveredKey = key();
        failPrinter = true;
        expect(409, "kitchen_delivery_uncertain", () -> execute("POST", "/v1/tickets/" + failureId + "/send", deliveredKey, sendBody(onceMore)));
        ObjectNode delivered = execute("POST", "/v1/tickets/" + failureId + "/kitchen/reconcile", key(),
                Request.JSON.createObjectNode().put("outcome", "delivered").put("confirmed", true));
        check(!delivered.path("kitchenDeliveryUncertain").booleanValue()
                && delivered.path("ticket").path("items").get(1).path("sentToKitchen").booleanValue(), "manager can record verified physical delivery without reprinting");
        ObjectNode deliveredReplay = execute("POST", "/v1/tickets/" + failureId + "/send", deliveredKey, sendBody(onceMore));
        check(deliveredReplay.path("delivery").textValue().equals("manager_confirmed_delivered")
                && deliveredReplay.path("kitchenTicketIds").size() == 1, "reconciled replay returns only this dispatch's kitchen IDs");
        failPrinter = false;
        displayTests(failureId, delivered);
    }

    private void displayTests(int id, ObjectNode previous) throws Exception {
        ObjectNode added = appendDisplayItem(id, previous);
        String path = "/v1/tickets/" + id + "/send";
        expect(400, "invalid_request", () -> execute("POST", path, key(), sendBody(added).put("deliveryMode", "automatic")));
        FloreantBackend physical = new FloreantBackend(context, new FloreantBackend.KitchenPrinter() {
            public void validate(KitchenTicket ticket) { FloreantBackend.validatePrinter(ticket); }
            public void print(KitchenTicket ticket) { throw new AssertionError("Missing printer must not be invoked"); }
        });
        expect(409, "missing_kitchen_printer", () -> physical.execute(new Request("POST", path, key(), sendBody(added))));
        ObjectNode afterPreflight = execute("GET", "/v1/tickets/" + id, null, Request.JSON.createObjectNode());
        check(!afterPreflight.path("kitchenDeliveryUncertain").booleanValue(), "printer preflight failure never creates an uncertain dispatch");
        FloreantBackend display = new FloreantBackend(context, new FloreantBackend.KitchenPrinter() {
            public void validate(KitchenTicket ticket) { throw new AssertionError("Display mode must not inspect physical queues"); }
            public void print(KitchenTicket ticket) { throw new AssertionError("Display mode must never print"); }
        });
        ObjectNode before = execute("GET", "/v1/tickets/" + id + "/kitchen", null, Request.JSON.createObjectNode());
        String key = key();
        ObjectNode body = sendBody(afterPreflight).put("deliveryMode", "kitchen_display");
        ObjectNode sent = display.execute(new Request("POST", path, key, body));
        check("persisted_to_kitchen_display".equals(sent.path("delivery").textValue()), "explicit kitchen display response");
        check(!sent.path("kitchenDeliveryUncertain").booleanValue(), "display dispatch has no nontransactional pending state");
        ObjectNode after = execute("GET", "/v1/tickets/" + id + "/kitchen", null, Request.JSON.createObjectNode());
        check(after.path("kitchenTickets").size() == before.path("kitchenTickets").size() + 1, "native kitchen display ticket persisted");
        JsonNode latest = after.path("kitchenTickets").get(after.path("kitchenTickets").size() - 1);
        check("WAITING".equals(latest.path("status").textValue()) && latest.path("tableNumbers").get(0).intValue() == 2,
                "display ticket has native waiting status and correct table");
        check(latest.path("items").toString().contains("Display only instruction"), "display readback includes cooking instructions");
        check(com.floreantpos.model.dao.KitchenTicketDAO.getInstance().findAllOpen().stream()
                .anyMatch(ticket -> ticket.getId().equals(latest.path("id").intValue())),
                "native kitchen display DAO can find the persisted ticket");
        ObjectNode replay = display.execute(new Request("POST", path, key, body));
        check(replay.path("replayed").booleanValue() && replay.path("kitchenTicketIds").equals(sent.path("kitchenTicketIds")),
                "display retry never duplicates station tickets");
        check(execute("GET", "/v1/tickets/" + id + "/kitchen", null, Request.JSON.createObjectNode())
                .path("kitchenTickets").size() == after.path("kitchenTickets").size(), "display retry preserves kitchen ticket count");
        expect(409, "idempotency_key_reused", () -> display.execute(new Request("POST", path, key, sendBody(afterPreflight))));
        ObjectNode later = appendDisplayItem(id, sent);
        ObjectNode laterSent = display.execute(new Request("POST", path, key(), sendBody(later).put("deliveryMode", "kitchen_display")));
        ObjectNode kitchens = execute("GET", "/v1/tickets/" + id + "/kitchen", null, Request.JSON.createObjectNode());
        JsonNode laterKitchen = kitchens.path("kitchenTickets").get(kitchens.path("kitchenTickets").size() - 1);
        check(laterKitchen.path("items").size() == 2 && laterSent.path("kitchenTicketIds").size() == 1,
                "later display dispatch includes only new meal and its instruction");
    }

    private ObjectNode appendDisplayItem(int id, ObjectNode previous) throws Exception {
        ObjectNode body = batch(previous, itemId);
        ((ObjectNode) body.path("items").get(0)).putArray("instructions").add("Display only instruction");
        return execute("POST", "/v1/tickets/" + id + "/items", key(), body);
    }

    private void fractionalTests() throws Exception {
        ObjectNode tab = execute("POST", "/v1/tables/3/tab", key(), tabBody());
        int id = tab.path("ticket").path("id").intValue();
        ObjectNode body = batch(tab, fractionalItemId);
        ((ObjectNode) body.path("items").get(0)).put("quantity", 0.5);
        ObjectNode added = execute("POST", "/v1/tickets/" + id + "/items", key(), body);
        check(added.path("ticket").path("total").doubleValue() == 2.20
                && added.path("ticket").path("tax").doubleValue() == 0.20, "exact native fractional price and tax");
        check(stock(fractionalItemId) == 9.5, "fractional stock decremented exactly once");
        ObjectNode tooMany = batch(added, fractionalItemId);
        ((ObjectNode) tooMany.path("items").get(0)).put("quantity", 10.0);
        expect(409, "insufficient_stock", () -> execute("POST", "/v1/tickets/" + id + "/items", key(), tooMany));
        check(stock(fractionalItemId) == 9.5, "rejected stock request preserves stock");
        ObjectNode invalid = batch(added, itemId);
        ((ObjectNode) invalid.path("items").get(0)).put("quantity", 1.5);
        expect(400, "invalid_request", () -> execute("POST", "/v1/tickets/" + id + "/items", key(), invalid));
        try (ApiServer api = new ApiServer(0, TOKEN, Main.onPosThread(backend))) {
            api.start();
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + api.port() + "/v1/tickets/" + id + "/items").openConnection();
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(10000);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + TOKEN);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Idempotency-Key", key());
            connection.setDoOutput(true);
            try (java.io.OutputStream output = connection.getOutputStream()) {
                output.write(batch(added, fractionalItemId).toString().getBytes(StandardCharsets.UTF_8));
            }
            check(connection.getResponseCode() == 200, "real HTTP mutation runs through production POS thread adapter");
            try (InputStream input = connection.getInputStream()) {
                ObjectNode response = Request.object(Request.JSON.readTree(input), "response");
                check(response.path("ticket").path("items").size() == 2 && !response.path("replayed").booleanValue(),
                        "HTTP returns persisted native ticket shape");
            } finally {
                connection.disconnect();
            }
            check(stock(fractionalItemId) == 8.5, "HTTP mutation persisted stock reservation");
        }
        ObjectNode current = execute("GET", "/v1/tickets/" + id, null, Request.JSON.createObjectNode());
        ObjectNode twoMeals = batch(current, itemId);
        ObjectNode meals = (ObjectNode) twoMeals.path("items").get(0);
        meals.put("quantity", 2);
        meals.putArray("modifiers").addObject().put("groupId", modifierGroupId).put("modifierId", modifierId).put("quantity", 1).put("type", "extra");
        ObjectNode priced = execute("POST", "/v1/tickets/" + id + "/items", key(), twoMeals);
        check(priced.path("ticket").path("total").doubleValue() == 30.6, "two customized meals include per-meal modifier pricing");
    }

    private void receiptText(List<?> elements, StringBuilder text) {
        for (Object element : elements) {
            if (element instanceof net.sf.jasperreports.engine.JRPrintText) {
                text.append(((net.sf.jasperreports.engine.JRPrintText) element).getFullText()).append('\n');
            } else if (element instanceof net.sf.jasperreports.engine.JRPrintFrame) {
                receiptText(((net.sf.jasperreports.engine.JRPrintFrame) element).getElements(), text);
            }
        }
    }

    private double stock(int id) {
        Session session = TicketDAO.getInstance().createNewSession();
        try {
            return ((MenuItem) session.get(MenuItem.class, id)).getStockAmount();
        } finally {
            session.close();
        }
    }

    private ObjectNode tabBody() {
        return Request.JSON.createObjectNode().put("orderTypeId", context.type.getId()).put("guestCount", 2);
    }

    private ObjectNode batch(ObjectNode previous, int menuItemId) {
        ObjectNode body = Request.JSON.createObjectNode().put("expectedRevision", previous.path("ticket").path("revision").textValue());
        body.putArray("items").addObject().put("menuItemId", menuItemId).put("quantity", 1);
        return body;
    }

    private ObjectNode sendBody(ObjectNode previous) {
        return Request.JSON.createObjectNode().put("expectedRevision", previous.path("ticket").path("revision").textValue()).put("confirmed", true);
    }

    private ObjectNode execute(String method, String path, String key, ObjectNode body) throws Exception {
        return backend.execute(new Request(method, path, key, body));
    }

    private static String key() { return UUID.randomUUID().toString(); }

    private interface Action { void run() throws Exception; }

    private static void expect(int status, String code, Action action) throws Exception {
        try {
            action.run();
            throw new AssertionError("Expected " + code);
        } catch (ApiException e) {
            check(e.status == status && e.code.equals(code), "expected " + code + ", got " + e.code);
        }
    }

    private static void check(boolean condition, String message) {
        assertions++;
        if (!condition) throw new AssertionError(message);
    }

    private static final class Fixture implements FloreantBackend.Context {
        User user;
        Terminal terminal;
        Shift shift;
        OrderType type;
        Ticket edited;
        public boolean initialized() { return true; }
        public Terminal terminal() { return terminal; }
        public Shift shift() { return shift; }
        public List<OrderType> orderTypes() { return Collections.singletonList(type); }
        public boolean priceIncludesTax() { return false; }
        public User user() { return user; }
        public Ticket editedTicket() { return edited; }
    }
}
