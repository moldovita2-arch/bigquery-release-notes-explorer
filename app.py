import os
import re
import time
import requests
import xml.etree.ElementTree as ET
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

CACHE_FILE = os.path.join(os.path.dirname(__file__), 'cache.xml')
CACHE_TIMEOUT = 600  # 10 minutes

# In-memory store
_cached_notes = []
_last_fetch_time = 0
_feed_source = "fresh"

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
    
    # If forced, or cache expired, or empty in-memory cache
    if force or not _cached_notes or (current_time - _last_fetch_time > CACHE_TIMEOUT):
        url = "https://docs.cloud.google.com/feeds/bigquery-release-notes.xml"
        try:
            response = requests.get(url, timeout=10)
            if response.status_code == 200:
                with open(CACHE_FILE, 'wb') as f:
                    f.write(response.content)
                _cached_notes = parse_feed_xml(response.content)
                _last_fetch_time = current_time
                _feed_source = "fresh"
                return _cached_notes
        except Exception as e:
            print(f"Error fetching live feed: {e}")
        
        # Load from file cache if offline or fetch failed
        if os.path.exists(CACHE_FILE):
            try:
                with open(CACHE_FILE, 'rb') as f:
                    content = f.read()
                _cached_notes = parse_feed_xml(content)
                _feed_source = "file_cache"
                if _last_fetch_time == 0:
                    _last_fetch_time = os.path.getmtime(CACHE_FILE)
                return _cached_notes
            except Exception as e:
                print(f"Error reading file cache: {e}")
                
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
