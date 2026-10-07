from fastapi import HTTPException, Request

from app.services.auth import AuthenticatedUser


def current_user(request: Request) -> AuthenticatedUser:
    """The user set by BearerAuthMiddleware; tests override this dependency."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        # Defence in depth: only reachable if a /v1 route runs without the middleware.
        raise HTTPException(401, "Session expired or invalid.", headers={"WWW-Authenticate": "Bearer"})
    return AuthenticatedUser(user_id=user_id, email=getattr(request.state, "email", None))
