#!/bin/sh
# Push + redeploy the KidPlan GAS web app to the stable deployment ID.
# Reuses the soleilandtyler@ credentials and the fixed /exec URL.
set -e
cd "$(dirname "$0")"
AUTH="$HOME/.clasp-accounts/soleilandtyler.json"
DEPLOY_ID="AKfycbxJ7oc6WazWnkr0YLrE9S-2c4w04Xz6K4bRgx276EkJPYJN3Z48lnO56QeF9Hlm02ye"
clasp_config_auth="$AUTH" clasp push -f
clasp_config_auth="$AUTH" clasp deploy -i "$DEPLOY_ID"
