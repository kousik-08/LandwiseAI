import os
from datetime import datetime, timedelta
from typing import Optional, Union, Any
from jose import jwt, JWTError
from passlib.context import CryptContext
from dotenv import load_dotenv

load_dotenv()

# Configuration
SECRET_KEY = os.getenv("JWT_SECRET_KEY")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 1 day

# Password Hashing Context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

class AuthService:
    @staticmethod
    def hash_password(password: str) -> str:
        """Hash a password for storage."""
        return pwd_context.hash(password)

    @staticmethod
    def verify_password(plain_password: str, hashed_password: str) -> bool:
        """Verify a plain password against its hash."""
        return pwd_context.verify(plain_password, hashed_password)

    @staticmethod
    def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
        """Create a new JWT access token."""
        to_encode = data.copy()
        if expires_delta:
            expire = datetime.utcnow() + expires_delta
        else:
            expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
        
        to_encode.update({"exp": expire})
        encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
        return encoded_jwt

    @staticmethod
    def decode_access_token(token: str) -> Optional[dict]:
        """Decode and verify a JWT access token."""
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            return payload if payload.get("exp") >= datetime.utcnow().timestamp() else None
        except JWTError:
            return None

    @staticmethod
    def validate_password_strength(password: str) -> bool:
        """
        Validates password strength:
        - Min 8 characters
        - At least 1 uppercase
        - At least 1 lowercase
        - At least 1 number
        - At least 1 special character
        """
        import re
        if len(password) < 8:
            return False
        if not re.search(r"[a-z]", password):
            return False
        if not re.search(r"[A-Z]", password):
            return False
        if not re.search(r"\d", password):
            return False
        if not re.search(r"[ !@#$%^&*(),.?\":{}|<>]", password):
            return False
        return True
