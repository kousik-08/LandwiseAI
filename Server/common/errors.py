from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.encoders import jsonable_encoder
import traceback
from common.utils import Utils


def register_exception_handlers(app: FastAPI):
    """
    Registers global exception handlers to return standardized JSON responses
    and log errors using the request-scoped logger.
    """

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        # Log the error
        if hasattr(request.state, "logger"):
            request.state.logger.log_error(f"HTTP {exc.status_code}: {exc.detail}")

        # Construct standard error response
        # User Friendly: We trust HTTP Exceptions raised by our code to have safe messages
        content = Utils.construct_output(
            response=None,  # No data
            status_code=exc.status_code,
            message=str(exc.detail),
        )
        return JSONResponse(
            status_code=exc.status_code,
            content=content,
            headers={"X-Request-ID": getattr(request.state, "request_id", "")},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        request: Request, exc: RequestValidationError
    ):
        # Log the full validation error for debugging
        # exc.errors() contains raw objects in 'ctx', we need to convert them
        error_details = jsonable_encoder(exc.errors())

        if hasattr(request.state, "logger"):
            request.state.logger.log_error(f"Validation Error: {error_details}")

        # Construct user-friendly messages
        # Format: "Field 'field_name': error message"
        friendly_errors = []
        for err in error_details:
            # err['loc'] includes ('body', 'field') usually. We skip 'body' for cleaner msg
            loc = ".".join([str(x) for x in err.get("loc", []) if x != "body"])
            msg = err.get("msg", "Invalid value")
            friendly_errors.append(f"Field '{loc}': {msg}")

        # Construct standard error response
        content = Utils.construct_output(
            response=friendly_errors, status_code=422, message="Input Validation Failed"
        )
        return JSONResponse(
            status_code=422,
            content=content,
            headers={"X-Request-ID": getattr(request.state, "request_id", "")},
        )

    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception):
        # Log the unexpected error with full details
        error_trace = traceback.format_exc()

        if hasattr(request.state, "logger"):
            request.state.logger.log_error(
                f"Internal Server Error: {str(exc)}\nTraceback: {error_trace}"
            )

        # Construct standard error response - GENERIC MESSAGE FOR USER
        content = Utils.construct_output(
            response=None, status_code=500, message="Internal Server Error"
        )
        return JSONResponse(
            status_code=500,
            content=content,
            headers={"X-Request-ID": getattr(request.state, "request_id", "")},
        )
