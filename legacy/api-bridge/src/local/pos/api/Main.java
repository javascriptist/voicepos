package local.pos.api;

import com.floreantpos.main.Application;
import com.floreantpos.ui.views.order.OrderView;
import com.floreantpos.model.Ticket;
import com.floreantpos.model.User;
import com.floreantpos.model.OrderType;
import com.floreantpos.model.Terminal;
import com.floreantpos.model.Shift;
import java.util.List;
import java.util.concurrent.FutureTask;
import javax.swing.SwingUtilities;

public final class Main {
    private Main() {}

    public static void main(String[] args) throws Exception {
        String port = System.getenv("POS_API_PORT");
        final FloreantBackend nativeBackend = new FloreantBackend(new FloreantBackend.Context() {
            public boolean initialized() { return Application.getInstance().isSystemInitialized(); }
            public Terminal terminal() { return Application.getInstance().getTerminal(); }
            public Shift shift() { return Application.getInstance().getCurrentShift(); }
            public List<OrderType> orderTypes() { return Application.getInstance().getOrderTypes(); }
            public boolean priceIncludesTax() { return Application.getInstance().isPriceIncludesTax(); }
            public User user() { return Application.getCurrentUser(); }
            public Ticket editedTicket() {
                Application app = Application.getInstance();
                if (!app.isSystemInitialized() || app.getRootView() == null) {
                    return null;
                }
                OrderView view = OrderView.getInstance();
                return view.isVisible() ? view.getCurrentTicket() : null;
            }
        }, new FloreantBackend.KitchenPrinter() {
            public void validate(com.floreantpos.model.KitchenTicket ticket) { FloreantBackend.validatePrinter(ticket); }
            public void print(com.floreantpos.model.KitchenTicket ticket) throws Exception { FloreantBackend.print(ticket); }
        });
        ApiServer api = new ApiServer(port == null ? 8787 : Integer.parseInt(port),
                System.getenv("POS_API_TOKEN"), onPosThread(nativeBackend));
        Runtime.getRuntime().addShutdownHook(new Thread(api::close, "pos-api-shutdown"));
        try {
            com.floreantpos.main.Main.main(args);
            api.start();
        } catch (Exception e) {
            api.close();
            throw e;
        }
    }

    static Backend onPosThread(Backend backend) {
        return request -> {
            FutureTask<com.fasterxml.jackson.databind.node.ObjectNode> task =
                    new FutureTask<com.fasterxml.jackson.databind.node.ObjectNode>(() -> backend.execute(request));
            SwingUtilities.invokeLater(task);
            try {
                return task.get();
            } catch (java.util.concurrent.ExecutionException e) {
                Throwable cause = e.getCause();
                if (cause instanceof Exception) {
                    throw (Exception) cause;
                }
                throw new IllegalStateException("POS execution failed", cause);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw e;
            }
        };
    }
}
