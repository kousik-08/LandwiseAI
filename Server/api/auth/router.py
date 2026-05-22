from fastapi import APIRouter, Depends, HTTPException, status, Response, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr

from common.database import get_db
from common.landwise_models import User, Role
from services.auth_service import AuthService

router = APIRouter(prefix="/auth", tags=["authentication"])


class SignupRequest(BaseModel):
    full_name: str
    email: EmailStr
    password: str
    role_name: str = "legal_advisor"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str

# Dependency to get current user from token
async def get_current_user(request: Request, db: Session = Depends(get_db)):
    token = request.cookies.get("session_token")
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    
    payload = AuthService.decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session",
        )
    
    user_id = payload.get("sub")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )
    
    return user

@router.post("/signup")
async def signup(
    payload: SignupRequest,
    db: Session = Depends(get_db)
):
    existing_user = db.query(User).filter(User.email == payload.email).first()
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered. Please login.",
        )

    if not AuthService.validate_password_strength(payload.password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password is too weak. Must be 8+ chars, with upper, lower, number, and special character.",
        )

    role = db.query(Role).filter(Role.name == payload.role_name).first()
    if not role:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid role: {payload.role_name}",
        )

    new_user = User(
        full_name=payload.full_name,
        email=payload.email,
        password_hash=AuthService.hash_password(payload.password),
        role_id=role.id,
        system_role=role.name,
        is_active=True
    )

    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    return {"message": "User created successfully", "user_id": new_user.id}

@router.post("/login")
async def login(
    payload: LoginRequest,
    response: Response,
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.email == payload.email).first()

    # Return identical 401s for "no such user" and "wrong password" so the
    # endpoint can't be used to enumerate registered emails. Using 404 here
    # also collided with route-not-found in client error handling.
    if not user or not AuthService.verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    access_token = AuthService.create_access_token(data={"sub": user.id})

    response.set_cookie(
        key="session_token",
        value=access_token,
        httponly=True,
        max_age=60 * 60 * 24,
        samesite="none",
        secure=True,
    )
    
    return {
        "status": "success",
        "user": {
            "id": user.id,
            "full_name": user.full_name,
            "email": user.email,
            "role": user.system_role
        }
    }

@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie("session_token")
    return {"message": "Logged out successfully"}

@router.get("/me")
async def get_me(current_user: User = Depends(get_current_user)):
    return {
        "id": current_user.id,
        "full_name": current_user.full_name,
        "email": current_user.email,
        "role": current_user.system_role
    }
