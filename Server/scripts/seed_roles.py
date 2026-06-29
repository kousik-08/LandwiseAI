import sys
import os

# Add the parent directory to sys.path to import common
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from common.database import SessionLocal, Base, engine
from common.landwise_models import Role

def seed_roles():
    db = SessionLocal()
    roles = [
        {"name": "super_admin", "description": "System Administrator with full access"},
        {"name": "portfolio_manager", "description": "Manages multiple projects and handles escalations"},
        {"name": "legal_advisor", "description": "Verifies documents and drafts legal opinions"}
    ]
    
    try:
        # Create tables if they don't exist
        Base.metadata.create_all(bind=engine)
        
        for r_data in roles:
            existing = db.query(Role).filter(Role.name == r_data["name"]).first()
            if not existing:
                role = Role(name=r_data["name"], description=r_data["description"])
                db.add(role)
                print(f"Added role: {r_data['name']}")
            else:
                print(f"Role already exists: {r_data['name']}")
        
        db.commit()
    except Exception as e:
        print(f"Error seeding roles: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    seed_roles()
