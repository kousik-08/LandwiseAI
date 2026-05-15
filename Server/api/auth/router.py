from fastapi import APIRouter, Depends, HTTPException, status, Response, Request
from sqlalchemy.orm import Session
from datetime import timedelta
from typing import Optional

from common.database import get_db
from common.landwise_models import User, Role
from services.auth_service import AuthService

router = APIRouter(prefix="/auth", tags=["authentication"])

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
    full_name: str,
    email: str,
    password: str,
    role_name: str = "legal_advisor",
    db: Session = Depends(get_db)
):
    # Check if user already exists
    existing_user = db.query(User).filter(User.email == email).first()
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered. Please login.",
        )
    
    # Validate password strength
    if not AuthService.validate_password_strength(password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password is too weak. Must be 8+ chars, with upper, lower, number, and special character.",
        )
    
    # Get role
    role = db.query(Role).filter(Role.name == role_name).first()
    if not role:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid role: {role_name}",
        )
    
    # Create user
    new_user = User(
        full_name=full_name,
        email=email,
        password_hash=AuthService.hash_password(password),
        role_id=role.id,
        system_role=role.name, # Sync for compatibility
        is_active=True
    )
    
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    
    return {"message": "User created successfully", "user_id": new_user.id}

@router.post("/login")
async def login(
    response: Response,
    email: str,
    password: str,
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.email == email).first()
    
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User does not exist. Please sign up.",
        )
    
    if not AuthService.verify_password(password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect password",
        )
    
    # Create token
    access_token = AuthService.create_access_token(data={"sub": user.id})
    
    # Set cookie
    response.set_cookie(
        key="session_token",
        value=access_token,
        httponly=True,
        max_age=60 * 60 * 24, # 1 day
        samesite="lax",
        secure=False # Set to True in production with HTTPS
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
