package local.pos.api;

public final class ApiException extends RuntimeException {
    private static final long serialVersionUID = 1L;
    public final int status;
    public final String code;

    public ApiException(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    static ApiException invalid(String message) {
        return new ApiException(400, "invalid_request", message);
    }

    static ApiException conflict(String code, String message) {
        return new ApiException(409, code, message);
    }
}
