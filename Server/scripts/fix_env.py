# Fix for corrupted .env file (UTF-16 with null bytes)
env_path = r'd:\Master_legal_AI_Stable_Hierarchy - Copy - Copy - Copy\Server\.env'

try:
    with open(env_path, 'rb') as f:
        content = f.read()
    
    # Remove null bytes and other potential garbage
    # UTF-16 content will look like 'J\0W\0T\0...'
    # We'll just filter for printable ASCII characters for now as it's an .env file
    clean_lines = []
    lines = content.splitlines()
    for line in lines:
        # Decode and remove nulls
        try:
            # Try to decode as UTF-16 if it looks like it, otherwise UTF-8
            if b'\x00' in line:
                decoded = line.decode('utf-16', errors='ignore')
            else:
                decoded = line.decode('utf-8', errors='ignore')
            
            clean_line = decoded.strip()
            if clean_line:
                clean_lines.append(clean_line)
        except:
            continue

    # Rewrite the file cleanly
    with open(env_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(clean_lines) + '\n')
    
    print("Cleaned .env file successfully.")
except Exception as e:
    print(f"Error cleaning file: {e}")
