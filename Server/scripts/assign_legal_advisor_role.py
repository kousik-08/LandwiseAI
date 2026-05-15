"""
Assign legal_advisor role to existing users.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from common.database import SessionLocal
from common.landwise_models import User, Role

def assign():
    db = SessionLocal()
    try:
        # Get the legal_advisor role
        role = db.query(Role).filter(Role.name == 'legal_advisor').first()
        if not role:
            print("legal_advisor role not found! Run seed_roles.py first.")
            return
        
        print(f"Found legal_advisor role: {role.id}")
        
        # Get all users with NULL role_id
        users = db.query(User).filter(User.role_id == None).all()
        print(f"\nFound {len(users)} users without a role")
        
        # Assign legal_advisor role to all users
        for u in users:
            print(f"  Assigning legal_advisor role to: {u.full_name} ({u.email})")
            u.role_id = role.id
        
        db.commit()
        print(f"\n✓ Assigned legal_advisor role to {len(users)} users")
        
        # Verify
        print("\n=== Users with legal_advisor role now ===")
        advisors = db.query(User).filter(User.role_id == role.id).all()
        for u in advisors:
            print(f"  - {u.full_name} ({u.email})")
            
    finally:
        db.close()

if __name__ == "__main__":
    assign()
