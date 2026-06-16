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

def init_db():
    try:
        with sqlite3.connect(DB_FILE) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS release_notes (
                    id TEXT PRIMARY KEY,
                    date TEXT,
                    raw_date TEXT,
                    category TEXT,
                    content TEXT,
                    link TEXT,
                    fetched_at REAL
                )
            ''')
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS cache_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT
                )
            ''')
            conn.commit()
    except Exception as e:
        print(f"Error initializing SQLite database: {e}")

def save_notes_to_db(notes, source_type="fresh"):
    try:
        with sqlite3.connect(DB_FILE) as conn:
            cursor = conn.cursor()
            current_time = time.time()
            for note in notes:
                cursor.execute('''
                    INSERT OR REPLACE INTO release_notes (id, date, raw_date, category, content, link, fetched_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                ''', (note['id'], note['date'], note['raw_date'], note['category'], note['content'], note['link'], current_time))
            
            cursor.execute('''
                INSERT OR REPLACE INTO cache_metadata (key, value)
                VALUES (?, ?)
            ''', ('last_fetch_time', str(current_time)))
            cursor.execute('''
                INSERT OR REPLACE INTO cache_metadata (key, value)
                VALUES (?, ?)
            ''', ('feed_source', source_type))
            conn.commit()
    except Exception as e:
        print(f"Error saving release notes to database: {e}")

def load_notes_from_db():
    if not os.path.exists(DB_FILE):
        return [], 0, "error"
    try:
        with sqlite3.connect(DB_FILE) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute('SELECT * FROM release_notes ORDER BY raw_date DESC')
            rows = cursor.fetchall()
            notes = [dict(row) for row in rows]
            
            cursor.execute('SELECT value FROM cache_metadata WHERE key = ?', ('last_fetch_time',))
            row = cursor.fetchone()
            last_fetch_time = float(row[0]) if row else 0.0
            
            cursor.execute('SELECT value FROM cache_metadata WHERE key = ?', ('feed_source',))
            row = cursor.fetchone()
            feed_source = row[0] if row else "db_cache"
            
            return notes, last_fetch_time, feed_source
    except Exception as e:
        print(f"Error loading from SQLite: {e}")
        return [], 0, "error"

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
