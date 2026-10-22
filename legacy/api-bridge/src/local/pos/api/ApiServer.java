package local.pos.api;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import java.util.logging.Logger;

public final class ApiServer implements AutoCloseable {
    private static final Logger LOG = Logger.getLogger(ApiServer.class.getName());
    private static final int MAX_BODY = 65536;
    private final HttpServer server;
    private final ThreadPoolExecutor executor;
    private final byte[] authorization;
    private final Backend backend;

    public ApiServer(int port, String token, Backend backend) throws IOException {
        if (token == null || token.length() < 32 || !token.matches("[A-Za-z0-9_-]+")) {
            throw new IllegalArgumentException("POS_API_TOKEN must contain at least 32 letters, digits, underscores or hyphens.");
        }
        if (port < 0 || port > 65535) {
            throw new IllegalArgumentException("Invalid POS_API_PORT.");
        }
        this.backend = backend;
        authorization = ("Bearer " + token).getBytes(StandardCharsets.UTF_8);
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 16);
        executor = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
                new ArrayBlockingQueue<Runnable>(16), new ThreadPoolExecutor.AbortPolicy());
        server.setExecutor(executor);
        server.createContext("/", this::handle);
    }

    public void start() {
        server.start();
        LOG.info("POS API listening on http://127.0.0.1:" + port() + "/v1 (authenticated, local only)");
    }

    public int port() {
        return server.getAddress().getPort();
    }

    private void handle(HttpExchange exchange) throws IOException {
        String requestId = UUID.randomUUID().toString();
        int status = 200;
        ObjectNode response;
        try {
            String auth = exchange.getRequestHeaders().getFirst("Authorization");
            if (auth == null || !MessageDigest.isEqual(authorization, auth.getBytes(StandardCharsets.UTF_8))) {
                exchange.getResponseHeaders().set("WWW-Authenticate", "Bearer");
                throw new ApiException(401, "unauthorized", "A valid bearer token is required.");
            }
            if (exchange.getRequestHeaders().containsKey("Origin")) {
                throw new ApiException(403, "browser_access_denied", "Call this API from your trusted backend, not directly from a browser.");
            }
            String path = exchange.getRequestURI().getRawPath();
            if (exchange.getRequestURI().getRawQuery() != null || !path.matches("/v1/[a-z0-9/-]+")) {
                throw ApiException.invalid("Use a documented /v1 path without query parameters.");
            }
            String method = exchange.getRequestMethod();
            if (!"GET".equals(method) && !"POST".equals(method)) {
                exchange.getResponseHeaders().set("Allow", "GET, POST");
                throw new ApiException(405, "method_not_allowed", "Only GET and POST are supported.");
            }
            byte[] bytes = readBody(exchange.getRequestBody());
            ObjectNode body = Request.JSON.createObjectNode();
            if ("POST".equals(method)) {
                String type = exchange.getRequestHeaders().getFirst("Content-Type");
                if (type == null || !type.split(";", 2)[0].trim().equalsIgnoreCase("application/json")) {
                    throw new ApiException(415, "unsupported_media_type", "Use Content-Type: application/json.");
                }
                try (JsonParser parser = Request.JSON.getFactory().createParser(bytes)) {
                    parser.enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION);
                    JsonNode node = Request.JSON.readTree(parser);
                    body = Request.object(node, "body");
                    if (parser.nextToken() != null) {
                        throw ApiException.invalid("Only one JSON object is allowed.");
                    }
                } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
                    throw ApiException.invalid("Malformed JSON body.");
                }
            } else if (bytes.length != 0) {
                throw ApiException.invalid("GET requests must not have a body.");
            }
            Request request = new Request(method, path, exchange.getRequestHeaders().getFirst("Idempotency-Key"), body);
            if (request.mutation()) {
                request.operationKey();
            }
            response = backend.execute(request);
        } catch (ApiException e) {
            status = e.status;
            response = error(e.code, e.getMessage(), requestId);
            LOG.warning(requestId + " " + e.code + " HTTP " + status);
        } catch (Exception e) {
            status = 500;
            response = error("internal_error", "POS operation failed. Check the local POS log using requestId; do not blindly retry kitchen dispatch.", requestId);
            LOG.log(Level.SEVERE, requestId + " POS API failure", e);
        }
        byte[] output = Request.JSON.writeValueAsBytes(response);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        exchange.getResponseHeaders().set("X-Request-Id", requestId);
        try {
            exchange.sendResponseHeaders(status, output.length);
            exchange.getResponseBody().write(output);
        } finally {
            exchange.close();
        }
    }

    private byte[] readBody(InputStream stream) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = stream.read(buffer)) != -1) {
            if (output.size() + count > MAX_BODY) {
                throw new ApiException(413, "body_too_large", "Maximum request size is 64 KiB.");
            }
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private ObjectNode error(String code, String message, String requestId) {
        ObjectNode result = Request.JSON.createObjectNode();
        ObjectNode error = result.putObject("error");
        error.put("code", code);
        error.put("message", message);
        error.put("requestId", requestId);
        return result;
    }

    @Override
    public void close() {
        server.stop(1);
        executor.shutdownNow();
    }
}
