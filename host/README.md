# Hosting Tap

Hosted Tap serves the same tools over HTTPS for AI apps that can't start a local server (ChatGPT, Claude on the web).
People sign in with Google, and Tap asks Google only for an anonymous account id (scope `openid`), never a name or email.
Each person's data is one JSON file in `~/.tap/hosted/users/`, named by a hash of that id.

## 1. Google sign-in

In Google Cloud Console, on any project:

1. **Google Auth Platform → Branding:** app name `Tap`, plus a support email.
2. **Audience:** External, then **Publish app**. `openid` alone needs no Google review.
3. **Clients → Create client → Web application**, with the authorized redirect URI `https://YOUR_HOST/oauth/google`.

## 2. Install and configure (as the service user)

```sh
npm install -g tap-mcp
mkdir -p ~/.tap && cp host/run.sh ~/.tap/run.sh   # or download it from GitHub
umask 077
cat > ~/.tap/hosted.env <<EOT
TAP_BASE_URL=https://YOUR_HOST
TAP_SECRET=$(openssl rand -base64 48)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
EOT
```

Fill in the two Google values with an editor. Don't paste them into a chat or your shell history.
`TAP_SECRET` signs every token: changing it signs everyone out.

## 3. Run it and put it on HTTPS

```sh
sed "s/SERVICE_USER/$(whoami)/g" host/com.tap.hosted.plist | sudo tee /Library/LaunchDaemons/com.tap.hosted.plist >/dev/null
sudo launchctl bootstrap system /Library/LaunchDaemons/com.tap.hosted.plist
curl -s 127.0.0.1:3232/healthz                      # {"ok":true}
tailscale funnel --bg --https=8443 http://127.0.0.1:3232   # or any HTTPS proxy
```

People then add `https://YOUR_HOST/mcp` as a connector in their AI app.

**Update:** `npm install -g tap-mcp@latest && sudo launchctl kickstart -k system/com.tap.hosted`
