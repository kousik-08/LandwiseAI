
import sys
import os
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError

# Add the parent directory to sys.path to import common
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from common.database import engine

def migrate():
    print("Connecting to database to apply LandwiseDocument binary migration...")
    with engine.connect() as conn:
        try:
            conn.execute(text("ALTER TABLE lw_documents ADD COLUMN file_content BYTEA"))
            conn.commit()
            print("[+] Added file_content column to lw_documents.")
        except ProgrammingError as e:
            conn.rollback()
            if "already exists" in str(e):
                print("[!] file_content column already exists.")
            else:
                raise e

    print("[***] Migration complete.")

if __name__ == "__main__":
    migrate()
