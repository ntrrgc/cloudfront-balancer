#!/bin/bash
set -eu
rsync -P ./ --exclude node_modules -r pi@192.168.0.230:cloudfront-balancer/
ssh pi@192.168.0.230 sudo systemctl restart cloudfront-balancer