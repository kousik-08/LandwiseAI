import sys
import os
sys.path.append(os.path.abspath('.'))
from common.database import engine, Base
from sqlalchemy import create_engine
engine = create_engine("postgresql://postgres:postgres@127.0.0.1:5432/landwiseai")
from common.landwise_models import ChatMessage
try:
    Base.metadata.create_all(engine)
    print("Tables created successfully.")
except Exception as e:
    print(f"Error: {e}")
