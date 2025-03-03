export function createDhcpWatcher(pairs: { wanInterface: string; fromIp: string; table: number }[]) {
    const interfaces = [...new Set(pairs.map(pair => pair.wanInterface))];
    const ret = `#!/bin/bash

add_or_replace_route() {
    local wan_interface="$1"
    local from_ip="$2"
    local table="$3"
    local gateway="$4"

    # Add or replace the default route
    if [ -n "$gateway" ]; then
        ip route replace default via $gateway dev $wan_interface proto static src $from_ip table $table
    else
        ip route replace default blackhole table $table
    fi
}

# Function to update the DHCP lease
update_dhcp_lease() {
    local interface=$1
    echo "Updating DHCP lease for interface $interface"

    local lease_file="/run/systemd/netif/leases/$(cat /sys/class/net/$interface/uevent | grep 'IFINDEX=' | cut -d'=' -f2)"
    local router="$(cat $lease_file | grep 'ROUTER=' | cut -d'=' -f2)"
    echo $router

    ${pairs.map(pair => `
    if [ "$interface" = "${pair.wanInterface}" ]; then
        add_or_replace_route "${pair.wanInterface}" "${pair.fromIp}" ${pair.table} $router
    fi
        `).join('\n\n')}
}

# List of interfaces to monitor
interfaces=(${interfaces.map(iface => `"${iface}"`).join(' ')})

# Function to get the current MD5 hash of the lease file for an interface
get_lease_hash() {
    local interface=$1
    local lease_file="/run/systemd/netif/leases/$(cat /sys/class/net/$interface/uevent | grep 'IFINDEX=' | cut -d'=' -f2)"
    if [[ -f $lease_file ]]; then
        md5sum $lease_file | cut -d' ' -f1
    else
        echo "missing"
    fi
}

# Initial hashes for each interface
declare -A initial_hashes
for interface in "\${interfaces[@]}"; do
    initial_hashes[$interface]="initial"
done

# Main loop to monitor changes
while true; do
    for interface in "\${interfaces[@]}"; do
        current_hash=$(get_lease_hash $interface)
        if [[ \${initial_hashes[$interface]} != $current_hash ]]; then
            update_dhcp_lease $interface
            initial_hashes[$interface]=$current_hash
        fi
    done
    sleep 5
done
`;
    return ret;
}
