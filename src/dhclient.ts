export function generateDhClientHooks(pairs: { wanInterface: string; fromIp: string; table: number }[]): string {
    const script = `#!/bin/sh

# dhclient hook to add default routes to specific routing tables

# Check if the new_routers variable is not empty
if [ -z "$new_routers" ]; then
    exit 0
fi

# Check if the interface variable is provided
if [ -z "$interface" ]; then
    exit 0
fi

# Function to add or replace default routes
add_or_replace_route() {
    local wan_interface="$1"
    local from_ip="$2"
    local table="$3"
    local gateway="$new_routers"

    # Add or replace the default route
    ip route replace default via $gateway dev $wan_interface proto static src $from_ip table $table
}

# Process each WAN interface and LAN IP pair
${pairs.map(pair => `
if [ "$interface" = "${pair.wanInterface}" ]; then
    echo add_or_replace_route "${pair.wanInterface}" "${pair.fromIp}" ${pair.table} >> /tmp/dhclient-hooks.log
    add_or_replace_route "${pair.wanInterface}" "${pair.fromIp}" ${pair.table}
fi
`).join('\n\n')}
`;

    return script;
}
