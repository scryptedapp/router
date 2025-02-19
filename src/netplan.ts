export type NetplanConfig = {
  network: {
    version: number;
    ethernets?: Record<string, EthernetInterface>;
    vlans?: Record<string, VlanInterface>;
  };
};

type EthernetInterface = {
  dhcp4?: boolean;
  dhcp6?: boolean;
  addresses?: string[];
  gateway4?: string;
  gateway6?: string;
  nameservers?: {
    addresses?: string[];
    search?: string[];
  };
  match?: {
    name?: string;
    driver?: string;
    macaddress?: string;
  };
  'set-name'?: string;
  mtu?: number;
  wakeonlan?: boolean;
  'accept-ra'?: boolean;
  optional?: boolean;
  routes?: Route[];
  'routing-policy'?: RoutingPolicy[];
  'dhcp-identifier'?: 'mac' | 'duid';
  'dhcp4-overrides'?: Dhcp4Overrides;
  'dhcp6-overrides'?: Dhcp6Overrides;
  // Add other Ethernet interface properties as needed
};

type VlanInterface = {
  id: number;
  link: string;
  dhcp4?: boolean;
  dhcp6?: boolean;
  addresses?: string[];
  gateway4?: string;
  gateway6?: string;
  nameservers?: {
    addresses?: string[];
    search?: string[];
  };
  match?: {
    name?: string;
    driver?: string;
    macaddress?: string;
  };
  'set-name'?: string;
  mtu?: number;
  wakeonlan?: boolean;
  'accept-ra'?: boolean;
  optional?: boolean;
  routes?: Route[];
  'routing-policy'?: RoutingPolicy[];
  'dhcp-identifier'?: 'mac' | 'duid';
  'dhcp4-overrides'?: Dhcp4Overrides;
  'dhcp6-overrides'?: Dhcp6Overrides;
  // Add other Vlan interface properties as needed
};
type Route = {
  to?: string;
  via?: string;
  from?: string;
  metric?: number;
  table?: number;
  type?: 'unicast' | 'blackhole' | 'unreachable' | 'prohibit' | 'throw' | 'local' | 'broadcast' | 'multicast' | 'any' | 'mpls';
  'on-link'?: boolean;
  scope?: 'host' | 'link' | 'global';
};

type RoutingPolicy = {
  from?: string;
  to?: string;
  table?: number;
  priority?: number;
  type?: 'unicast' | 'blackhole' | 'unreachable' | 'prohibit' | 'throw' | 'local' | 'broadcast' | 'multicast' | 'any' | 'mpls';
  oif?: string;
  iif?: string;
  tos?: number;
  ipproto?: string;
  sport?: number;
  dport?: number;
  uidrange?: string;
  fwmark?: number;
  invert?: boolean;
};

type Dhcp4Overrides = {
  'send-hostname'?: boolean;
  'use-hostname'?: boolean;
  'use-mtu'?: boolean;
  'use-routes'?: boolean;
  'use-dns'?: boolean;
  'route-metric'?: number;
  'route-table'?: number;
  'use-ntp'?: boolean;
  'use-domain'?: boolean;
  'use-.Dynamic-DNS'?: boolean;
};

type Dhcp6Overrides = {
  'send-hostname'?: boolean;
  'use-hostname'?: boolean;
  'use-mtu'?: boolean;
  'use-routes'?: boolean;
  'use-dns'?: boolean;
  'route-metric'?: number;
  'route-table'?: number;
  'use-ntp'?: boolean;
  'use-domain'?: boolean;
  'use-raft6'?: boolean;
};
