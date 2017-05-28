#!/bin/bash
rsync ./ --exclude node_modules -r pi@192.168.0.230:cloudfront-balancer/