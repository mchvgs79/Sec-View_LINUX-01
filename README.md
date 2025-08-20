# Linux Client Agent

This repository contains the Sec Viewer linux-client agent.

Usage
1. Clone or download: git clone https://github.com/MCHVGS79/Sec-View_LINUX-01.git
2. Run the installer on a Debian/Ubuntu target:
   sudo ./scripts/install.sh https://github.com/MCHVGS79/Sec-View_LINUX-01.git

DNS-SRV discovery
------------------

The agent supports simple DNS-SRV discovery for controller endpoints. Set the
environment variable `CONTROLLER_SRV` to a DNS SRV name and the agent will
resolve it and try the returned targets first when attempting to enroll.

Example SRV records (BIND zone format):

_sec-viewer._tcp.example.com. 3600 IN SRV 10 5 8080 controller1.example.com.
_sec-viewer._tcp.example.com. 3600 IN SRV 20 5 8080 controller2.example.com.

Notes:
- Each SRV target (controller1.example.com) must also have an A and/or AAAA
   record so it can be resolved to an IP address.
- The agent maps each SRV record to a controller URL of the form
   `http://<target>:<port>` and tries them in the discovered order. If you
   need HTTPS endpoints, either publish the full URL via the `CONTROLLER_URLS`
   env variable or configure the agent to use `https://` URLs explicitly.
- SRV discovery is optional — if not set the agent will use the
   `CONTROLLER_URL` or default to `http://localhost:8080`.

Environment examples (systemd drop-in):

[Service]
Environment=CONTROLLER_SRV=_sec-viewer._tcp.example.com

DHCP discovery
--------------

The agent can also attempt to discover controller endpoints via DHCP options.
Set `CONTROLLER_DHCP_OPTION` to the DHCP option name or number that your DHCP
server uses to convey the controller URL(s). Optionally set
`CONTROLLER_DHCP_LEASEFILE` to point to a specific lease file to parse.

Example environment:

[Service]
Environment=CONTROLLER_DHCP_OPTION=sec-viewer-controllers
Environment=CONTROLLER_DHCP_LEASEFILE=/run/systemd/netif/leases/10

Notes:
- The agent will scan common DHCP lease locations and extract values for the
   configured option. It supports several common textual formats used by
   dhclient, systemd-networkd, and NetworkManager lease files.
- Values found are normalized into URLs (e.g. `controller.example.com:8080` ->
   `http://controller.example.com:8080`). If you need HTTPS, provide full
   URLs via the `CONTROLLER_URLS` environment variable.
- DHCP discovery is optional; if no DHCP data is found the agent falls back to
   DNS-SRV and environment variables as described above.

Recommended option number
-------------------------

The agent accepts either an option name or a numeric DHCP option value via
`CONTROLLER_DHCP_OPTION`. We recommend using a site-specific option number in
the 224-254 range to avoid colliding with standard DHCP options. A common
choice is `224`.

Example (numeric option 224) for `dhcpd.conf`:

```
# declare site-specific option number
option sec-viewer-controllers code 224 = string;

# advertise controllers for a subnet
subnet 10.0.0.0 netmask 255.255.255.0 {
   option sec-viewer-controllers "controller1.example.com:8080,controller2.example.com:8080";
   ...
}
```

Or publish the numeric option directly if you prefer:

```
option option-224 code 224 = string;
option option-224 "controller1.example.com:8080";
```

Then configure the agent (systemd drop-in) to use the numeric option name or the
named option:

[Service]
Environment=CONTROLLER_DHCP_OPTION=sec-viewer-controllers
OR
Environment=CONTROLLER_DHCP_OPTION=224
