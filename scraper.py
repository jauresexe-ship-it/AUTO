import sys
import os
import json
import time
import random
import cloudscraper
from urllib.parse import urljoin, quote

class APKDownloader:
    def __init__(self):
        self.scraper = cloudscraper.create_scraper(
            browser={'browser': 'chrome', 'platform': 'windows', 'mobile': False}
        )
        self.scraper.headers.update({
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive'
        })
        self.base_url = 'https://apkpure.com'
        self.download_dir = 'downloads'
        
        if not os.path.exists(self.download_dir):
            os.makedirs(self.download_dir)
    
    def random_delay(self, min_sec=0.3, max_sec=0.8):
        time.sleep(random.uniform(min_sec, max_sec))
    
    def search_app(self, package_name):
        try:
            import re
            
            # Try direct APKPure URLs first (faster)
            app_name_slug = package_name.split('.')[-1]
            possible_urls = [
                f"{self.base_url}/{app_name_slug}/{package_name}",
                f"{self.base_url}/{app_name_slug}-app/{package_name}",
            ]
            
            for url in possible_urls:
                self.random_delay(0.3, 0.6)
                
                response = self.scraper.get(url, timeout=15)
                
                if response.status_code == 200 and package_name in response.text:
                    return url
            
            return None
            
        except Exception as e:
            return None
    
    def get_download_link(self, app_url):
        try:
            download_page = f"{app_url}/download"
            
            self.random_delay(0.5, 1)
            response = self.scraper.get(download_page, timeout=20)
            
            if response.status_code != 200:
                return None
            
            import re
            
            # Check for XAPK first (games with OBB/data)
            # XAPK patterns are prioritized for better detection
            patterns = [
                (r'href="(https://d\.apkpure\.com/b/XAPK/[^"]+)"', 'XAPK', True),
                (r'href="(https://d\.apkpure\.com/b/APK/[^"]+)"', 'APK', False),
                (r'href="(https://download\.apkpure\.com/b/XAPK/[^"]+)"', 'XAPK', True),
                (r'href="(https://download\.apkpure\.com/b/APK/[^"]+)"', 'APK', False),
                (r'data-dt-file="([^"]+xapk[^"]*)"', 'XAPK', True),
                (r'data-dt-file="([^"]+)"', 'APK', False),
            ]
            
            for pattern, file_type, is_xapk in patterns:
                match = re.search(pattern, response.text, re.IGNORECASE)
                if match:
                    download_url = match.group(1)
                    if not download_url.startswith('http'):
                        download_url = 'https:' + download_url if download_url.startswith('//') else urljoin(self.base_url, download_url)
                    return {'url': download_url, 'is_xapk': is_xapk, 'type': file_type}
            
            return None
            
        except Exception as e:
            return None
    
    def download_apk(self, package_name):
        try:
            app_url = self.search_app(package_name)
            
            if not app_url:
                return {'error': 'App not found'}
            
            download_info = self.get_download_link(app_url)
            
            if not download_info:
                return {'error': 'Download link not found'}
            
            download_url = download_info['url']
            is_xapk = download_info['is_xapk']
            
            self.random_delay(0.5, 1)
            response = self.scraper.get(download_url, timeout=60, stream=True)
            
            if response.status_code != 200:
                return {'error': f'Download failed with status {response.status_code}'}
            
            content_disposition = response.headers.get('content-disposition', '')
            if 'filename=' in content_disposition:
                filename = content_disposition.split('filename=')[1].strip('"\'')
            else:
                ext = '.xapk' if is_xapk else '.apk'
                filename = f"{package_name}{ext}"
            
            # Ensure correct extension
            if is_xapk and not filename.endswith(('.xapk', '.apks')):
                filename = filename.rsplit('.', 1)[0] + '.xapk'
            elif not is_xapk and not filename.endswith('.apk'):
                filename = filename.rsplit('.', 1)[0] + '.apk'
            
            file_path = os.path.join(self.download_dir, filename)
            
            with open(file_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=262144):
                    if chunk:
                        f.write(chunk)
            
            file_size = os.path.getsize(file_path)
            
            return {
                'success': True,
                'file_path': file_path,
                'filename': filename,
                'size': file_size,
                'is_xapk': is_xapk
            }
            
        except Exception as e:
            return {'error': str(e)}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No package name provided'}))
        sys.exit(1)
    
    package_name = sys.argv[1]
    
    downloader = APKDownloader()
    result = downloader.download_apk(package_name)
    
    print(json.dumps(result))

if __name__ == '__main__':
    main()
