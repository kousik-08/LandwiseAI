"""
Check if legal_advisor role exists and list users with that role.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from common.database import SessionLocal
from common.landwise_models import User, Role

def check():
    db = SessionLocal()
    try:
        # Check roles
        print("=== All Roles ===")
        roles = db.query(Role).all()
        for r in roles:
            print(f"  - {r.name} (id: {r.id})")
        
        # Check for legal_advisor role
        print("\n=== Legal Advisor Role ===")
        role = db.query(Role).filter(Role.name == 'legal_advisor').first()
        if role:
            print(f"Found: {role.name} (id: {role.id})")
            
            # Find users with this role
            print(f"\n=== Users with legal_advisor role ===")
            advisors = db.query(User).filter(User.role_id == role.id).all()
            if advisors:
                for u in advisors:
                    print(f"  - {u.full_name} ({u.email}, id: {u.id})")
            else:
                print("  NO USERS FOUND with legal_advisor role!")
                print("\n  You need to either:")
                print("  1. Sign up a new user with legal_advisor role, or")
                print("  2. Update an existing user to have the legal_advisor role")
        else:
            print("  legal_advisor role NOT FOUND in database!")
            print("  Run: python scripts/seed_roles.py")
        
        # Show all users
        print("\n=== All Users ===")
        users = db.query(User).all()
        for u in users:
            role_name = db.query(Role).filter(Role.id == u.role_id).first()
            role_str = role_name.name if role_name else f"unknown({u.role_id})"
            print(f"  - {u.full_name} ({u.email}) - role: {role_str}")
            
    finally:
        db.close()

if __name__ == "__main__":
    check()
