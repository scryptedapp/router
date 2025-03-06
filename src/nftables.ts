function addMasquerade(nftables: Set<string>, ip: 'ip' | 'ip6', wanInterface: string) {
    const table = `
table ${ip} nat {
    chain postrouting_scrypted {
        oif "${wanInterface}" masquerade
    }
}
`;

    nftables.add(table);
}

export function addWanGateway(nftables: Set<string>, ip: 'ip' | 'ip6', wanInterface: string, lanInterface: string) {
    addMasquerade(nftables, ip, wanInterface);

    const table = `
table ${ip} filter {
    chain forward_scrypted {
        iif "${lanInterface}" oif "${wanInterface}" accept
        iif "${wanInterface}" oif "${lanInterface}" ct state established,related accept
    }
}
`;

    nftables.add(table);
}

export function flushChains(nftables: Set<string>) {
    nftables.add(`
flush chain ip nat postrouting_scrypted
flush chain ip6 nat postrouting_scrypted
flush chain ip filter forward_scrypted
flush chain ip6 filter forward_scrypted
flush chain ip nat prerouting_scrypted
flush chain ip6 nat prerouting_scrypted
`);
}

export function addPortForward(nftables: Set<string>, ip: 'ip' | 'ip6', wanInterface: string, wanIps: string[], lanInterfaces: Set<string>, protocol: 'tcp' | 'udp' | 'tcp + udp' | 'https', srcPort: string, dstIp: string, dstPort: number) {
    let actualProto: string = protocol;
    if (protocol === 'tcp + udp')
        actualProto = 'meta l4proto { tcp, udp } th';

    addMasquerade(nftables, ip, wanInterface);

    const forward = `
table ${ip} filter {
    chain forward_scrypted {
        iif "${wanInterface}" ip daddr ${dstIp} ${actualProto} dport ${dstPort} accept
    }
}
`;
    nftables.add(forward);

    const prerouting = `
table ${ip} nat {
    chain prerouting_scrypted {
        iif "${wanInterface}" ${actualProto} dport ${srcPort} dnat to ${dstIp}:${dstPort}
    }
}
`;
    nftables.add(prerouting);

    for (const wanIp of wanIps) {

        for (const lanInterface of lanInterfaces) {
            addMasquerade(nftables, ip, lanInterface);

            const forward = `
            table ${ip} filter {
                chain forward_scrypted {
                    iif "${lanInterface}" ip daddr ${dstIp} ${actualProto} dport ${dstPort} accept
                    iif "${lanInterface}" oif "${lanInterface}" ct state established,related accept
                }
            }
            `;
            nftables.add(forward);

            // this isn't matching the wan ip address or interface, which isn't great.
            const prerouting = `
table ${ip} nat {
    chain prerouting_scrypted {
        iif "${lanInterface}" ip daddr ${wanIp} ${actualProto} dport ${srcPort} dnat to ${dstIp}:${dstPort}
    }
}
`;
            nftables.add(prerouting);
        }
    }

}
