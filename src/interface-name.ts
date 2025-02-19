export function getInterfaceName(parentInterface: string, vlanId: number) {
    if (vlanId !== 1)
        return `${parentInterface}.${vlanId}`;
    return parentInterface;
}