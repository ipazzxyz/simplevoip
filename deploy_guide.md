# Production Deployment Guide - SimpleVoIP WebRTC Server

This guide details the steps required to deploy the SimpleVoIP WebRTC server on your Linux Virtual Dedicated Server (VDS) using Docker, Docker Compose, Nginx, and Let's Encrypt for free HTTPS/WSS.

---

## 1. Prerequisites on VDS

Ensure Docker, Docker Compose, and Nginx are installed on your Linux VDS (Ubuntu/Debian):

```bash
# Update package list and install docker + nginx
sudo apt update
sudo apt install -y docker.io docker-compose nginx certbot python3-certbot-nginx
```

---

## 2. Prepare DNS

Go to your Domain Registrar or DNS host and point a subdomain (e.g., `voip.ipazzxyz.tech`) to your VDS's public IP address with an **A-Record**.

---

## 3. Clone and Run using Docker Compose

1. Transfer your project files to the VDS (via `git clone` or secure copy `scp`).
2. Navigate to the project root directory containing `docker-compose.yml`.
3. Spin up the application in detached mode (background):
   ```bash
   sudo docker-compose up --build -d
   ```
4. Verify the container status:
   ```bash
   sudo docker ps
   ```
   *The container should be running and mapping port `8080` internally to `127.0.0.1`.*

---

## 4. Configure Nginx Reverse Proxy (Initial Port 80 Setup)

To obtain an SSL certificate via Certbot, we first configure Nginx to listen on port `80` and route traffic to the containerized server.

1. Open a new configuration file:
   ```bash
   sudo nano /etc/nginx/sites-available/webrtc
   ```
2. Paste the following configuration, replacing `voip.ipazzxyz.tech` with your subdomain (if different):
   ```nginx
   server {
       listen 80;
       server_name voip.ipazzxyz.tech;

       location / {
           proxy_pass http://127.0.0.1:8080;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }

       location /ws {
           proxy_pass http://127.0.0.1:8080/ws;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "Upgrade";
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_read_timeout 86400s;
       }
   }
   ```
3. Enable the site and restart Nginx:
   ```bash
   sudo ln -s /etc/nginx/sites-available/webrtc /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   ```

---

## 5. Enable HTTPS and WSS (SSL Certificate via Certbot)

Use Certbot to request a free certificate from Let's Encrypt. The Certbot Nginx plugin will automatically obtain the certificates, write the `ssl_certificate` directives, add the `443` HTTPS server block, and configure HTTP-to-HTTPS redirect:

```bash
sudo certbot --nginx -d voip.ipazzxyz.tech
```

Select the option to redirect all traffic to HTTPS if prompted. Certbot automatically adds a cron job to renew the certificates every 3 months.


---

## 6. Verification

Navigate to `https://voip.ipazzxyz.tech` on both your desktop and smartphone. The browser will request microphone and camera access over secure HTTPS, enabling WebRTC calling.
