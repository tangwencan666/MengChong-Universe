from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, SecretStr, field_validator


def strong_password(value: SecretStr) -> SecretStr:
    password = value.get_secret_value()
    categories = sum(
        (
            any(c.islower() for c in password),
            any(c.isupper() for c in password),
            any(c.isdigit() for c in password),
            any(not c.isalnum() for c in password),
        )
    )
    if (
        len(password) < 12
        or categories < 3
        or password.lower()
        in {
            "password123!",
            "password1234!",
            "qwerty123456!",
            "123456789abc!",
        }
    ):
        raise ValueError("Use 12-128 characters and at least three character categories")
    return value


class EmailInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr = Field(max_length=254)

    @field_validator("email", mode="after")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return str(value).lower()


class Credentials(EmailInput):
    password: SecretStr = Field(min_length=1, max_length=128)


class Registration(Credentials):
    display_name: str = Field(min_length=1, max_length=60)

    @field_validator("display_name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(character) < 32 for character in value):
            raise ValueError("Invalid display name")
        return value

    @field_validator("password")
    @classmethod
    def strong_password(cls, value: SecretStr) -> SecretStr:
        return strong_password(value)


class VerificationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: SecretStr = Field(min_length=43, max_length=128)


class ResetPasswordInput(VerificationInput):
    password: SecretStr = Field(min_length=12, max_length=128)

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: SecretStr) -> SecretStr:
        return strong_password(value)


class CurrentUser(BaseModel):
    id: UUID
    email: str
    display_name: str
    role: str
    status: str
    email_verified: bool


class SessionView(BaseModel):
    id: UUID
    created_at: datetime
    expires_at: datetime
    last_seen_at: datetime
    current: bool
