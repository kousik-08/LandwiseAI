import sys
import os
from sqlalchemy import text

# Add the parent directory to sys.path to import common
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from common.database import SessionLocal, Base, engine
from common.landwise_models import Role

def recreate_roles():
    db = SessionLocal()
    try:
        # Drop and recreate only the roles table
        print("Dropping roles table if exists...")
        db.execute(text("DROP TABLE IF EXISTS roles CASCADE;"))
        db.commit()
        
        print("Recreating roles table...")
        Role.__table__.create(engine)
        db.commit()
        print("Success.")
    except Exception as e:
        print(f"Error recreating roles: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    recreate_roles()
