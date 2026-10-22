package local.pos.api;

import com.fasterxml.jackson.databind.node.ObjectNode;

public interface Backend {
    ObjectNode execute(Request request) throws Exception;
}
