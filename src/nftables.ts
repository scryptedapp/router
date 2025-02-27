export function generateWanGateway(pairs: {
    ipVersion: 'ip' | 'ip6',
    wanInterface: string,
    lanInterface: string
}[]): string {
    const ipPairs = pairs.filter(pair => pair.ipVersion === 'ip');
    const ip6Pairs = pairs.filter(pair => pair.ipVersion === 'ip6');

    let config = `
flush chain ip nat postrouting_scrypted
flush chain ip6 nat postrouting_scrypted
flush chain ip filter forward_scrypted
flush chain ip6 filter forward_scrypted
flush chain ip nat prerouting_scrypted
flush chain ip6 nat prerouting_scrypted
`;

    const generateIpPair = (ip: string, pairs: typeof ipPairs) => {
        config += `
table ${ip} nat {
`;

        const masqueraded = new Set<string>();

        config += `
    chain postrouting_scrypted {
`;
        for (const pair of pairs) {
            const { wanInterface } = pair;

            if (masqueraded.has(wanInterface))
                continue;
            masqueraded.add(wanInterface);

            config += `
        oif "${wanInterface}" masquerade
`

        }
        config += `
    }
}`;

        config += `

table ${ip} filter {
`;


        config += `
    chain forward_scrypted {
`;


        for (const pair of pairs) {
            const { wanInterface, lanInterface } = pair;

            config += `
        iif "${lanInterface}" oif "${wanInterface}" accept
        iif "${wanInterface}" oif "${lanInterface}" ct state established,related accept
`;
        }
        config += `
    }
}`;

    };

    generateIpPair('ip', ipPairs);
    generateIpPair('ip6', ip6Pairs);
    return config;
}

export function generatePortForward(pairs: {
    ipVersion: 'ip' | 'ip6',
    wanInterface: string,
    protocol: 'tcp' | 'udp' | 'tcp + udp' | 'https',
    srcPort: string,
    dstIp: string,
    dstPort: number
}[]): string {
    let config = ``;

    pairs.forEach(pair => {
        const { ipVersion, wanInterface, protocol, srcPort, dstIp, dstPort } = pair;

        let actualProto: string = protocol;
        if (protocol === 'tcp + udp') 
            actualProto = 'meta l4proto { tcp, udp } th'

        //         iif "${wanInterface}" oif ${lanInterface} ${actualProto} ip daddr ${dstIp} dport ${dstPort} accept

        config += `
table ${ipVersion} filter {
    chain forward_scrypted {
        iif "${wanInterface}" ip daddr ${dstIp} ${actualProto} dport ${dstPort} accept
    }
}

table ${ipVersion} nat {
    chain prerouting_scrypted {
        iif "${wanInterface}" ${actualProto} dport ${srcPort} dnat to ${dstIp}:${dstPort}
    }
}
`;
    });
    return config;
}
