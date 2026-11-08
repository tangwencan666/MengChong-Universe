from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as DatabaseTimeoutError
from starlette.exceptions import HTTPException as StarletteHTTPException


class AppError(Exception):
    def __init__(self, status: int, code: str, message: str, headers: dict | None = None):
        self.status, self.code, self.message = status, code, message
        self.headers = headers


class NotImplementedFeature(AppError):
    def __init__(self, feature: str):
        super().__init__(501, "NOT_IMPLEMENTED", f"{feature} 尚未实现；当前仅提供框架接口。")


def error_response(request: Request, status: int, code: str, message: str, headers=None):
    return JSONResponse(
        status_code=status,
        content={
            "error": {"code": code, "message": message},
            "request_id": getattr(request.state, "request_id", None),
        },
        headers=headers,
    )


def install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(OperationalError)
    @app.exception_handler(DatabaseTimeoutError)
    async def database_unavailable(request: Request, exc: Exception):
        return error_response(
            request, 503, "DATABASE_UNAVAILABLE", "数据库暂时不可用，请稍后重试。"
        )

    @app.exception_handler(AppError)
    async def app_error(request: Request, exc: AppError):
        return error_response(request, exc.status, exc.code, exc.message, exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        # Validation details can echo passwords, prompts, and other private inputs.
        return error_response(request, 422, "VALIDATION_ERROR", "请求字段不符合接口约束。")

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return error_response(request, exc.status_code, "HTTP_ERROR", str(exc.detail), exc.headers)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception):
        return error_response(request, 500, "INTERNAL_ERROR", "服务暂时不可用。请提供请求 ID。")
