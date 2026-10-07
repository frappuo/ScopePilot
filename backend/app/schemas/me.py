from pydantic import BaseModel


class MeResponse(BaseModel):
    user_id: str
    email: str | None
