export function generateNftablesConf(pairs: {
    ipVersion: 'ip' | 'ip6',
    wanInterface: string,
    lanInterface: string
}[]): string {
    let config = '';

    pairs.forEach(pair => {
        const { ipVersion, wanInterface, lanInterface } = pair;

        config += `
table ${ipVersion} nat {
    chain postrouting {
        type nat hook postrouting priority 100; policy accept;
        oif "${wanInterface}" masquerade
    }
}
table ${ipVersion} filter {
    chain forward {
        type filter hook forward priority 0; policy drop;
        iif "${lanInterface}" oif "${wanInterface}" accept
        iif "${wanInterface}" oif "${lanInterface}" ct state established,related accept
    }
}
`;
    });

    return config.trim();
}