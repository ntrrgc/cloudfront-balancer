# CloudFront balancer for CrunchyRoll

CrunchyRoll uses CloudFront to serve its video files. Unfortunately, it has severe problems with performance, possibly due to bad load balancing: It happens very frequently that some servers may be able to serve files at more than 5 MB/s while other servers will struggle to serve at 50 KB/s, producing severe interruptions and quality drops very frequently.
 
Furthermore, the order of servers in the DNS response is renewed every 60 seconds, so even if you are lucky enough to get a good server, it may be swapped for a bad one short after. On the other hand, the refresh only affects requests for new video parts, so a bad server may leave the application stalled buffering a certain sequence for more than 10 minutes! At that point the most effective way to get it back working is to close the video and open it again, hoping a better server is selected.
  
Honestly, it's quite frustrating to watch anything with this poor infrastructure.

Since I can't fix the CrunchyRoll infrastructure and it's been quite a while since I reported the issue, I've done something extremely hacky in order to watch my anime without so much frustration.

This project is an experiment to get smooth streaming in CrunchyRoll by employing a smarter load balancer installed in the local network. This balancer, much like the user, has limited patience: it wait no more than a certain time span for each request to complete. If that time is exceeded, the server is considered slow and the request is retried with the next server. 

Unlike DNS load balancers, this one does not bind a request to an specific backend server for the lifetime of the request (remember, slow requests can take 10 minutes to succeed loading just a few seconds of video!). Instead, the backend request is retried in the new server transparently for the client. The part of the content the client has already retrieved is discarded silently and any data after that is fed to the client in the same response. This way you don't have to close the browser/app and retry again if it seems stuck: the load balancer already doing it under the hood.
     
Also unlike in the DNS load balancer, here a new server is only selected when the previous one is found to have become slow. This way the balancer avoids selecting potential bad server unnecessarily.

This load balancer does not inspect or modify the contents of the HTTP requests or responses. The same headers and body content received from the backend servers is sent as-is to the client. Therefore, it's relatively easy to modify it to be used with other networks having similar balancing issues. 

## Setup

Requirements:

 * A small Linux server with static IP, connected to the LAN (preferably over Ethernet) with free HTTP, HTTPS and DNS ports. A Raspberry Pi works fine.
 * A self-signed certification authority (CA).
 * Ability to add install the CA in the devices where the balancer is desired to be used.
 * Ability to either:
   * Modify `/etc/hosts` in the devices where the balancer is desired to be used.
   * Set a custom DNS server.
   
Installation steps:

1. Clone this repo somewhere in your server and `cd` to it.

2. Create a self-signed CA using [CA-baka](https://github.com/SethRobertson/CA-baka). Store them in a directory named `ca`.

    ```bash
    ./CA-baka --workdir ca/ --country US --state State --locality Locality --organization "cloudfront-proxy" --newca ca.cloudrfont-proxy.local ""
    ```

3. Create a certificate for the domain you need to intercept. In the case of CrunchyRoll, we want to intercept `v.vrv.co`.  

    ```bash
    ./CA-baka --workdir ca --newserver v.vrv.co email\@example.com
    ```

4. Install the root CA certificate, found in `./ca/ca.crt` in your devices. In order to install it in iOS you must serve the file with any HTTP server. Navigate to the URL of the certificate and you'll be prompted to install it as an authority.

   Of course, never publish the CA private key (`./ca/ca.key`) anywhere!
    
5. Run `npm install`.

6. Run `npm run run 192.168.0.230 v.vrv.co` with permission to use privileged ports. Unfortunately, there is no clean way to do this. You can either run it as root (dangerous) or set capabilities on the `node` executable (harder, will break if the `node` binary is updated, affects other programs as any process then could bind to privileged ports). If everything is fine, the following should be printed:

    ```text
    > cloudfront-balancer@1.0.0 run /home/pi/cloudfront-balancer
    > ts-node index.ts
    
    Load balancer listening on ports 53 (DNS), 80 (HTTP) and 443 (HTTPS).
    ```

7. Edit `/etc/hosts` to resolve `v.vrv.co` to `192.168.0.230`. Alternatively, you can use the provided DNS server, which will return the IP of the balancer when the intercepted domain is requested but will perform normal DNS resolution on any other request. 

   Unfortunately, this DNS server is very limited: it only supports A requests (no IPv6 AAAA, TEXT, MX o SRV records), so it should be used as a last resort.
   
8. Try it! Open some videos and look at the log entries to check that the balancer is working:

    ```text
    May 28 01:51:45 raspberrypi npm[3630]: 54.239.158.127: Downloaded 9.57 MB in 2.04 seconds (4.7 MB/s)
    May 28 01:51:47 raspberrypi npm[3630]: 54.239.158.127: Downloaded 9.73 MB in 1.72 seconds (5.67 MB/s)
    May 28 01:51:50 raspberrypi npm[3630]: 54.239.158.127: Downloaded 9.67 MB in 1.88 seconds (5.15 MB/s)
    May 28 01:51:58 raspberrypi npm[3630]: 54.239.158.127: Downloaded 8.44 MB in 1.55 seconds (5.46 MB/s)
    May 28 01:52:08 raspberrypi npm[3630]: 54.239.158.127: Downloaded 10.65 MB in 1.89 seconds (5.62 MB/s)
    May 28 01:52:26 raspberrypi npm[3630]: 54.239.158.127: Server seems slow. Retrying next with 54.239.158.190 after 703.09 KB
    May 28 01:52:29 raspberrypi npm[3630]: 54.239.158.190: Downloaded 8.8 MB in 2.28 seconds (3.87 MB/s)
    May 28 01:52:31 raspberrypi npm[3630]: 54.239.158.190: Downloaded 9.68 MB in 2.01 seconds (4.81 MB/s)
    May 28 01:52:39 raspberrypi npm[3630]: 54.239.158.190: Downloaded 6.98 MB in 2.04 seconds (3.42 MB/s)
    May 28 01:52:48 raspberrypi npm[3630]: 54.239.158.190: Downloaded 7.01 MB in 1.59 seconds (4.41 MB/s)
    ```
    
9. Stop it and create a system service so that it is started with the system. An example service file is provided for systemd in the repository.

    ```bash
    cp cloudfront-balancer.service /etc/systemd/system/
    $EDITOR /etc/systemd/system/cloudfront-balancer.service
    systemctl daemon-reload
    systemctl start cloudfront-balancer
    systemctl status cloudfront-balancer
    systemctl enable cloudfront-balancer
    ```
    
10. Reboot and check it's running correctly!
    
## License

Copyright 2017 Alicia Boya García

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
