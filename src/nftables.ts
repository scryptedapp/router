export function generateNftablesConf(pairs: {
    nativeId: string,
    ipVersion: 'ip' | 'ip6',
    wanInterface: string,
    lanInterface: string
}[]): string {
    let config = '';

    pairs.forEach(pair => {
        const { ipVersion, nativeId, wanInterface, lanInterface } = pair;

        config += `
table ${ipVersion} nat {
    chain POSTROUTING {
        type nat hook postrouting priority 100;
        oifname "${wanInterface}" jump ${nativeId}
    }

    chain ${nativeId} {
        oifname "${wanInterface}" masquerade
    }
}

# Create the filter table and chain
table ip filter {
    chain ${nativeId} {
        # Accept traffic from ${lanInterface} to ${wanInterface}
        iifname "${lanInterface}" oifname "${wanInterface}" accept

        # Accept related/established traffic from ${wanInterface} to ${lanInterface}
        iifname "${wanInterface}" oifname "${lanInterface}" ct state related,established accept
    }

    chain FORWARD {
        type filter hook forward priority 0;
        jump ${nativeId}
    }
}
`;
    });

    return config.trim();
}