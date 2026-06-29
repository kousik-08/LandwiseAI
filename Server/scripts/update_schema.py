#!/usr/bin/env python3
"""
Update database schema to add new columns to parcels table.
"""
import psycopg2
import sys
import os

# Add parent to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from common.database import DATABASE_URL

def update_schema():
    print("[*] Connecting to database...")
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    
    print("[*] Adding new columns to parcels table...")
    
    # Check if columns exist first
    cur.execute("""
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'parcels' 
        AND column_name IN ('total_docs_count', 'passed_docs_count', 'avg_trustability_score', 'scrutiny_docs_count');
    """)
    existing = [row[0] for row in cur.fetchall()]
    
    if 'total_docs_count' not in existing:
        cur.execute("ALTER TABLE parcels ADD COLUMN total_docs_count INTEGER DEFAULT 0;")
        print("  [+] Added total_docs_count")
    
    if 'passed_docs_count' not in existing:
        cur.execute("ALTER TABLE parcels ADD COLUMN passed_docs_count INTEGER DEFAULT 0;")
        print("  [+] Added passed_docs_count")
    
    if 'avg_trustability_score' not in existing:
        cur.execute("ALTER TABLE parcels ADD COLUMN avg_trustability_score NUMERIC(5,2) DEFAULT 0;")
        print("  [+] Added avg_trustability_score")
    
    if 'scrutiny_docs_count' not in existing:
        cur.execute("ALTER TABLE parcels ADD COLUMN scrutiny_docs_count INTEGER DEFAULT 0;")
        print("  [+] Added scrutiny_docs_count")
    
    # Check for deleted_at column
    cur.execute("""
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'parcels' 
        AND column_name = 'deleted_at';
    """)
    if not cur.fetchone():
        cur.execute("ALTER TABLE parcels ADD COLUMN deleted_at TIMESTAMP;")
        print("  [+] Added deleted_at")
    
    conn.commit()
    cur.close()
    conn.close()
    
    print("[+] Schema updated successfully!")

if __name__ == "__main__":
    update_schema()
