# notepad
Notepad Editor with some text tools

**Setup:**

Put `73-notepad.conf` in `/etc/lighttpd/conf-enabled/`

Put all other files in `/var/www/html/notepad`

**Set permissions:**

```
sudo chown -R www-data:www-data /var/www/html/notepad
sudo chmod 755 /var/www/html/notepad
sudo chmod 644 /var/www/html/notepad/*
```

**Restart lighttpd:**

`sudo systemctl restart lighttpd`

accessible at `http://YOUR-IP/notepad`

If you do not want to host locally (which can be done on a Pi 4 2GB) you can use the [online version](https://amec0e.github.io/notepad/)
