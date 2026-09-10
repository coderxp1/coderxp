import subprocess

conf = """# CoderXP Preview — Wildcard Preview Subdomain Nginx Config
# CONTAINMENT STATE: Live preview disabled pending dedicated host migration.
# Returns static HTTP 503 without proxying to any upstream port or loopback.

server {
    listen 80;
    server_name *.preview.coderxp.pro preview.coderxp.pro;
    default_type text/plain;
    return 503 "[CoderXP Live Preview Disabled] Live preview subsystem is inactive on shared infrastructure pending dedicated host migration.\\n";
}

server {
    listen 443 ssl http2;
    server_name *.preview.coderxp.pro preview.coderxp.pro;

    ssl_certificate     /etc/ssl/coderxp/fullchain.pem;
    ssl_certificate_key /etc/ssl/coderxp/privkey.pem;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;

    location / {
        default_type text/plain;
        return 503 "[CoderXP Live Preview Disabled] Live preview subsystem is inactive on shared infrastructure pending dedicated host migration.\\n";
    }
}
"""

proc = subprocess.Popen(
    ['ssh', '-i', 'C:/Users/hartm/.ssh/coderxp_deploy', 'root@31.70.107.44', 'cat > /etc/nginx/sites-available/coderxp-preview.conf && nginx -t && systemctl reload nginx'],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True
)
stdout, stderr = proc.communicate(conf)
print("Return code:", proc.returncode)
print("Stdout:", stdout)
print("Stderr:", stderr)
