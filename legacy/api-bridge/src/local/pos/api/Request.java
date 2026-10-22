package local.pos.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.UUID;

public final class Request {
    static final ObjectMapper JSON = new ObjectMapper();
    public final String method;
    public final String path;
    public final String key;
    public final ObjectNode body;

    Request(String method, String path, String key, ObjectNode body) {
        this.method = method;
        this.path = path;
        this.key = key;
        this.body = body;
    }

    boolean mutation() {
        return !"GET".equals(method);
    }

    String operationKey() {
        if (key == null || !key.matches("[0-9a-fA-F-]{36}")) {
            throw invalidKey();
        }
        try {
            if (!UUID.fromString(key).toString().equalsIgnoreCase(key)) {
                throw invalidKey();
            }
        } catch (IllegalArgumentException e) {
            throw invalidKey();
        }
        return "VOICE_API_" + key.toLowerCase(java.util.Locale.ROOT);
    }

    private ApiException invalidKey() {
        return ApiException.invalid("A UUID Idempotency-Key header is required for every mutation.");
    }

    String digest() {
        return sha256(method + "\n" + path + "\n" + body.toString());
    }

    static String sha256(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : bytes) {
                hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    static void fields(ObjectNode node, String... allowed) {
        Set<String> names = new HashSet<String>(Arrays.asList(allowed));
        Iterator<String> keys = node.fieldNames();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!names.contains(key)) {
                throw ApiException.invalid("Unknown field: " + key);
            }
        }
    }

    static int integer(ObjectNode node, String key, int min, int max) {
        JsonNode value = node.get(key);
        if (value == null || !value.isIntegralNumber() || !value.canConvertToInt()
                || value.intValue() < min || value.intValue() > max) {
            throw ApiException.invalid(key + " must be an integer between " + min + " and " + max + ".");
        }
        return value.intValue();
    }

    static String text(ObjectNode node, String key, int max) {
        JsonNode value = node.get(key);
        if (value == null || !value.isTextual() || value.textValue().trim().isEmpty()
                || value.textValue().length() > max || value.textValue().matches("(?s).*\\p{Cntrl}.*")) {
            throw ApiException.invalid(key + " must be nonempty text (maximum " + max + " characters, no control characters).");
        }
        return value.textValue();
    }

    static ObjectNode object(JsonNode value, String name) {
        if (value == null || !value.isObject()) {
            throw ApiException.invalid(name + " must be a JSON object.");
        }
        return (ObjectNode) value;
    }
}
