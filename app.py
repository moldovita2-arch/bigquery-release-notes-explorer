import os
import re
import time
import requests
import xml.etree.ElementTree as ET
import sqlite3
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# Adapt file paths dynamically for Vercel's writeable /tmp directory
if os.environ.get('VERCEL'):
    DB_FILE = '/tmp/release_notes.db'
    CACHE_FILE = '/tmp/cache.xml'
else:
    DB_FILE = os.path.join(os.path.dirname(__file__), 'release_notes.db')
    CACHE_FILE = os.path.join(os.path.dirname(__file__), 'cache.xml')

CACHE_TIMEOUT = 600  # 10 minutes

# In-memory store
_cached_notes = []
_last_fetch_time = 0
_feed_source = "fresh"

def get_db_connection():
    db_url = os.environ.get('DATABASE_URL')
    if db_url:
        import psycopg2
        # Replace postgres:// with postgresql:// if needed (psycopg2 requires postgresql://)
        if db_url.startswith("postgres://"):
            db_url = db_url.replace("postgres://", "postgresql://", 1)
        return psycopg2.connect(db_url), "%s"
    else:
        import sqlite3
        return sqlite3.connect(DB_FILE), "?"

def init_db():
    conn, p = get_db_connection()
    try:
        cursor = conn.cursor()
        
        # Use VARCHAR/TEXT types compatible with both sqlite3 and psycopg2
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS release_notes (
                id VARCHAR(255) PRIMARY KEY,
                date TEXT,
                raw_date VARCHAR(100),
                category VARCHAR(100),
                content TEXT,
                link TEXT,
                fetched_at REAL
            )
        ''')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS cache_metadata (
                key VARCHAR(100) PRIMARY KEY,
                value TEXT
            )
        ''')
        conn.commit()
    except Exception as e:
        print(f"Error initializing database: {e}")
    finally:
        conn.close()

def save_notes_to_db(notes, source_type="fresh"):
    conn, p = get_db_connection()
    try:
        cursor = conn.cursor()
        current_time = time.time()
        
        # Determine UPSERT syntax based on connection parameter marker
        if p == "%s":  # PostgreSQL (Neon)
            query = '''
                INSERT INTO release_notes (id, date, raw_date, category, content, link, fetched_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                    date = EXCLUDED.date,
                    raw_date = EXCLUDED.raw_date,
                    category = EXCLUDED.category,
                    content = EXCLUDED.content,
                    link = EXCLUDED.link,
                    fetched_at = EXCLUDED.fetched_at
            '''
            meta_query = '''
                INSERT INTO cache_metadata (key, value)
                VALUES (%s, %s)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
            '''
        else:  # SQLite (Local Dev)
            query = '''
                INSERT OR REPLACE INTO release_notes (id, date, raw_date, category, content, link, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            '''
            meta_query = '''
                INSERT OR REPLACE INTO cache_metadata (key, value)
                VALUES (?, ?)
            '''
            
        for note in notes:
            cursor.execute(query, (note['id'], note['date'], note['raw_date'], note['category'], note['content'], note['link'], current_time))
            
        cursor.execute(meta_query, ('last_fetch_time', str(current_time)))
        cursor.execute(meta_query, ('feed_source', source_type))
        conn.commit()
    except Exception as e:
        print(f"Error saving release notes to database: {e}")
    finally:
        conn.close()

def load_notes_from_db():
    db_url = os.environ.get('DATABASE_URL')
    if not db_url and not os.path.exists(DB_FILE):
        return [], 0, "error"
        
    conn, p = get_db_connection()
    try:
        cursor = conn.cursor()
        # Query order by raw_date desc
        cursor.execute('SELECT id, date, raw_date, category, content, link FROM release_notes ORDER BY raw_date DESC')
        rows = cursor.fetchall()
        
        # Map values by tuple index to remain database driver agnostic
        notes = []
        for row in rows:
            notes.append({
                'id': row[0],
                'date': row[1],
                'raw_date': row[2],
                'category': row[3],
                'content': row[4],
                'link': row[5]
            })
            
        cursor.execute(f"SELECT value FROM cache_metadata WHERE key = {p}", ('last_fetch_time',))
        row = cursor.fetchone()
        last_fetch_time = float(row[0]) if row else 0.0
        
        cursor.execute(f"SELECT value FROM cache_metadata WHERE key = {p}", ('feed_source',))
        row = cursor.fetchone()
        feed_source = row[0] if row else "db_cache"
        
        return notes, last_fetch_time, feed_source
    except Exception as e:
        print(f"Error loading from database: {e}")
        return [], 0, "error"
    finally:
        conn.close()

def parse_feed_xml(xml_content):
    root = ET.fromstring(xml_content)
    ns = {'atom': 'http://www.w3.org/2005/Atom'}
    entries = root.findall('atom:entry', ns)
    
    # Matches <h3>Category</h3> followed by content, stopping before the next <h3> or end of string.
    pattern = re.compile(r'<h3>(.*?)</h3>(.*?)(?=<h3>|$)', re.DOTALL)
    parsed_items = []
    
    for entry in entries:
        title = entry.find('atom:title', ns).text
        updated = entry.find('atom:updated', ns).text
        link_elem = entry.find('atom:link', ns)
        link = link_elem.attrib.get('href') if link_elem is not None else ""
        content_elem = entry.find('atom:content', ns)
        content_html = content_elem.text if content_elem is not None else ""
        entry_id = entry.find('atom:id', ns).text if entry.find('atom:id', ns) is not None else "id"
        
        matches = pattern.findall(content_html)
        if not matches:
            parsed_items.append({
                'id': f"{entry_id}_0",
                'date': title,
                'raw_date': updated,
                'category': 'Unknown',
                'content': content_html.strip(),
                'link': link
            })
        else:
            for idx, (category, content) in enumerate(matches):
                parsed_items.append({
                    'id': f"{entry_id}_{idx}",
                    'date': title,
                    'raw_date': updated,
                    'category': category.strip(),
                    'content': content.strip(),
                    'link': link
                })
    return parsed_items

def get_release_notes(force=False):
    global _cached_notes, _last_fetch_time, _feed_source
    current_time = time.time()
    
    # Initialize the database if it hasn't been set up yet
    init_db()
    
    # Check if memory cache is valid
    if not force and _cached_notes and (current_time - _last_fetch_time <= CACHE_TIMEOUT):
        return _cached_notes

    # If cache expired or forced, try to fetch from Google XML Feed
    url = "https://docs.cloud.google.com/feeds/bigquery-release-notes.xml"
    fetch_success = False
    try:
        response = requests.get(url, timeout=10)
        if response.status_code == 200:
            parsed_items = parse_feed_xml(response.content)
            save_notes_to_db(parsed_items, "fresh")
            
            # Backup raw XML file cache as well
            with open(CACHE_FILE, 'wb') as f:
                f.write(response.content)
                
            _cached_notes = parsed_items
            _last_fetch_time = current_time
            _feed_source = "fresh"
            fetch_success = True
            return _cached_notes
    except Exception as e:
        print(f"Error fetching live feed: {e}")
    
    # Fallback Tier 1: SQLite Database cache
    if not fetch_success:
        db_notes, db_fetch_time, db_source = load_notes_from_db()
        if db_notes:
            _cached_notes = db_notes
            _last_fetch_time = db_fetch_time
            _feed_source = "db_cache"
            return _cached_notes
            
        # Fallback Tier 2: Read from backup cache.xml (legacy migration path)
        if os.path.exists(CACHE_FILE):
            try:
                with open(CACHE_FILE, 'rb') as f:
                    content = f.read()
                parsed_items = parse_feed_xml(content)
                save_notes_to_db(parsed_items, "db_cache")
                
                _cached_notes = parsed_items
                _last_fetch_time = os.path.getmtime(CACHE_FILE)
                _feed_source = "db_cache"
                return _cached_notes
            except Exception as e:
                print(f"Error reading file cache: {e}")
                
        # If both database and file caches are empty or fail
        if not _cached_notes:
            _feed_source = "error"
            
    return _cached_notes

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/notes')
def api_notes():
    force = request.args.get('force', 'false').lower() == 'true'
    notes = get_release_notes(force=force)
    
    # Calculate statistics
    categories = {}
    for n in notes:
        cat = n['category']
        categories[cat] = categories.get(cat, 0) + 1
        
    return jsonify({
        'status': 'success',
        'source': _feed_source,
        'last_updated': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(_last_fetch_time)),
        'total_items': len(notes),
        'stats': categories,
        'notes': notes
    })

@app.route('/api/refresh', methods=['POST'])
def api_refresh():
    notes = get_release_notes(force=True)
    return jsonify({
        'status': 'success',
        'source': _feed_source,
        'last_updated': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(_last_fetch_time)),
        'total_items': len(notes)
    })

if __name__ == '__main__':
    app.run(debug=True, host='127.0.0.1', port=5000)
