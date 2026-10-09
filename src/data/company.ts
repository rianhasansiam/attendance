/** Public company facts supplied by XHYD. Keep claims and destinations here. */
export const company = {
  name: "XHYD",
  type: "Multinational Business Group",
  headquarters: "China",
  description:
    "XHYD is a multinational business group headquartered in China, connecting technology, manufacturing, international trade, and digital commerce across global markets.",
} as const;

export const navigation = [
  { label: "Home", href: "#home" },
  { label: "About XHYD", href: "#about" },
  { label: "Our Businesses", href: "#businesses" },
  { label: "Global Presence", href: "#global-presence" },
  { label: "Why XHYD", href: "#why-xhyd" },
  { label: "Contact", href: "#contact" },
] as const;

export type Business = {
  id: string;
  title: string;
  shortName: string;
  description: string;
  capabilities: readonly string[];
  category: string;
  icon: "code" | "network" | "factory" | "trade" | "boxes" | "commerce";
};

export const businesses = [
  {
    id: "software",
    title: "Software Development",
    shortName: "Technology",
    description:
      "Turning business ambition into digital capability. Purpose-built software, platforms, and automation for the way you work.",
    capabilities: [
      "Custom software & web applications",
      "Enterprise technology solutions",
      "Automation & digital transformation",
    ],
    category: "Build what’s next",
    icon: "code",
  },
  {
    id: "it-solutions",
    title: "IT Solutions & Support",
    shortName: "IT Support",
    description:
      "The technology behind business continuity. Infrastructure, consulting, and technical support that keep operations connected.",
    capabilities: [
      "IT infrastructure solutions",
      "Technical support & consulting",
      "Business technology management",
    ],
    category: "Enable everyday progress",
    icon: "network",
  },
  {
    id: "manufacturing",
    title: "Product Manufacturing",
    shortName: "Manufacturing",
    description:
      "Bringing ideas into the physical world through product development, production sourcing, and manufacturing partnerships.",
    capabilities: [
      "Product development & production",
      "Manufacturing partnerships",
      "Production sourcing",
    ],
    category: "Bring ideas to life",
    icon: "factory",
  },
  {
    id: "import-export",
    title: "Import & Export",
    shortName: "Import & Export",
    description:
      "Connecting products with international opportunity through cross-border sourcing, trade, and supply chain coordination.",
    capabilities: [
      "International import & export",
      "Cross-border product sourcing",
      "Supply chain coordination",
    ],
    category: "Move beyond borders",
    icon: "trade",
  },
  {
    id: "wholesale",
    title: "Wholesale & Distribution",
    shortName: "Wholesale",
    description:
      "Connecting supply with business demand. Bulk purchasing, wholesale product supply, and international B2B distribution.",
    capabilities: [
      "Wholesale product supply",
      "Bulk purchasing & distribution",
      "B2B business partnerships",
    ],
    category: "Extend your reach",
    icon: "boxes",
  },
  {
    id: "e-commerce",
    title: "E-commerce & Online Retail",
    shortName: "E-commerce",
    description:
      "Where products meet people. Digital commerce and online retail operations that connect consumer products with customers.",
    capabilities: [
      "Online product sales",
      "Digital commerce operations",
      "Consumer product distribution",
    ],
    category: "Connect with customers",
    icon: "commerce",
  },
] as const satisfies readonly Business[];

export const regions = [
  {
    id: "china",
    name: "China",
    role: "Headquarters",
    detail: "The foundation of our global business.",
    label: "CN",
  },
  {
    id: "bangladesh",
    name: "Bangladesh",
    role: "International branch",
    detail: "Connecting opportunity across South Asia.",
    label: "BD",
  },
  {
    id: "europe",
    name: "Europe",
    role: "International presence",
    detail: "Connecting with European markets.",
    label: "EU",
  },
  {
    id: "united-states",
    name: "United States",
    role: "International branch",
    detail: "Connecting opportunity in North America.",
    label: "US",
  },
] as const;

export const strengths = [
  {
    title: "Diversified Business Expertise",
    description:
      "A broader perspective across technology, manufacturing, trade, and commerce.",
  },
  {
    title: "International Connectivity",
    description:
      "A business presence that brings different markets and opportunities closer.",
  },
  {
    title: "Technology-Driven Solutions",
    description:
      "Digital thinking at the heart of how we build, connect, and operate.",
  },
  {
    title: "Integrated Business Operations",
    description:
      "Complementary capabilities that support more of your business journey.",
  },
  {
    title: "Partnership-Focused Approach",
    description:
      "Relationships built around shared direction and ongoing collaboration.",
  },
  {
    title: "Global Market Perspective",
    description:
      "A shared perspective shaped by China, Bangladesh, Europe, and the United States.",
  },
] as const;

export const partnerCategories = [
  "Technology clients",
  "Manufacturing partners",
  "Importers & exporters",
  "Wholesale buyers",
  "Distributors",
  "Enterprise clients",
] as const;
