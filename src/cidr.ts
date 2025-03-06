export function parseCidrIp(cidr: string) {
    return cidr.split('/')[0];
}
