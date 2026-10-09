import Image from "next/image";
import {
  ArrowDown,
  ArrowUpRight,
  Boxes,
  Code2,
  Factory,
  Globe2,
  Layers3,
  Network,
  PackageCheck,
  ShoppingBag,
  Ship,
  Sparkles,
} from "lucide-react";
import {
  businesses,
  company,
  partnerCategories,
  regions,
  strengths,
  type Business,
} from "@/data/company";
import { CorporateHeader } from "./header";
import { CorporateMotion, PartnershipContact } from "./interactions";
import { GlobalMap } from "./global-map";
import { ActionLink, Container, Eyebrow } from "./primitives";
import styles from "./home.module.css";

const businessIcons = {
  code: Code2,
  network: Network,
  factory: Factory,
  trade: Ship,
  boxes: Boxes,
  commerce: ShoppingBag,
};

function HeroSection() {
  return (
    <section id="home" aria-labelledby="hero-title" className={styles.hero}>
      <div className={styles.heroImage}>
        <Image
          src="/images/xhyd/skyline.webp"
          alt=""
          fill
          sizes="100vw"
          loading="eager"
          fetchPriority="high"
        />
      </div>
      <div className={styles.heroShade} aria-hidden="true" />
      <div className={styles.heroGrid} aria-hidden="true" />
      <svg
        className={styles.heroNetwork}
        viewBox="0 0 640 560"
        fill="none"
        aria-hidden="true"
      >
        <ellipse cx="362" cy="263" rx="223" ry="198" />
        <ellipse cx="362" cy="263" rx="153" ry="198" />
        <path d="M141 263H584M165 171C274 120 450 120 563 171M165 357C274 408 450 408 563 357" />
        <g className={styles.heroNetworkRoutes}>
          <path d="M194 232C275 31 509 39 525 209M194 232C289 338 425 367 492 323M525 209C480 242 481 280 492 323" />
          <circle cx="194" cy="232" r="5" />
          <circle cx="525" cy="209" r="7" />
          <circle cx="492" cy="323" r="5" />
          <circle cx="525" cy="209" r="19" />
        </g>
      </svg>
      <Container className={styles.heroInner}>
        <div className={styles.heroCopy}>
          <Eyebrow light>One group. A world of possibilities.</Eyebrow>
          <h1 id="hero-title">
            Connecting
            <br />
            Innovation, Industry
            <br />
            <span>&amp; Global Markets.</span>
          </h1>
          <p className={styles.heroDescription}>{company.description}</p>
          <div className={styles.heroActions}>
            <ActionLink href="#businesses">Explore Our Businesses</ActionLink>
            <ActionLink href="#partnerships" variant="outline">
              Partner With Us
            </ActionLink>
          </div>
        </div>
        <div className={styles.heroLocation} aria-hidden="true">
          <span className={styles.locationDot} />
          <span>
            Rooted in China.
            <br />
            <strong>Connected to the world.</strong>
          </span>
        </div>
        <div className={styles.heroBottom}>
          <a href="#about" className={styles.scrollLink}>
            <span className={styles.scrollIcon}>
              <ArrowDown size={16} aria-hidden="true" />
            </span>
            Discover the XHYD perspective
          </a>
          <div className={styles.heroRegions}>
            <Globe2 size={17} aria-hidden="true" />
            <span>China</span>
            <i /> <span>Bangladesh</span>
            <i />
            <span>Europe</span>
            <i />
            <span>United States</span>
          </div>
        </div>
      </Container>
    </section>
  );
}

function BusinessRibbon() {
  return (
    <div className={styles.businessRibbon} aria-label="Our business areas">
      <Container>
        <span className={styles.ribbonLabel}>
          A connected business ecosystem
        </span>
        <div className={styles.ribbonItems}>
          {businesses.map((business) => (
            <a key={business.id} href={`#business-${business.id}`}>
              <span aria-hidden="true" />
              {business.shortName}
            </a>
          ))}
        </div>
      </Container>
    </div>
  );
}

function AboutSection() {
  return (
    <section
      id="about"
      aria-labelledby="about-title"
      className={styles.aboutSection}
    >
      <Container className={styles.aboutGrid}>
        <div className={styles.aboutCopy} data-reveal>
          <Eyebrow>The XHYD perspective</Eyebrow>
          <h2 id="about-title">
            One company.
            <br />
            Multiple industries.
            <br />
            <span>Global opportunities.</span>
          </h2>
          <p className={styles.lead}>
            Different capabilities. One shared direction.
          </p>
          <p>
            We bring technology, manufacturing, international trade, and digital
            commerce together under one identity. Headquartered in China, XHYD
            connects businesses and partners across Bangladesh, Europe, and the
            United States.
          </p>
          <p>
            Our divisions work within a connected ecosystem — from the digital
            solutions that power a business to the products and networks that
            bring it to market.
          </p>
          <ActionLink href="#ecosystem" variant="text">
            Discover XHYD
          </ActionLink>
        </div>
        <div className={styles.aboutVisual} data-reveal>
          <Image
            src="/images/xhyd/architecture.webp"
            alt="Illustrative monochrome view of contemporary glass architecture"
            fill
            sizes="(max-width: 760px) 100vw, 45vw"
          />
          <div className={styles.visualCaption}>
            <span className={styles.captionIcon}>
              <Layers3 size={24} strokeWidth={1.5} aria-hidden="true" />
            </span>
            <span>
              Built on connection.
              <br />
              <strong>Designed for possibility.</strong>
            </span>
            <ArrowUpRight size={25} aria-hidden="true" />
          </div>
          <span className={styles.visualIndex} aria-hidden="true">
            XHYD / A GLOBAL PERSPECTIVE
          </span>
        </div>
      </Container>
    </section>
  );
}

function BusinessCard({
  business,
  index,
}: {
  business: Business;
  index: number;
}) {
  const Icon = businessIcons[business.icon];
  const featured = index === 0;
  const trade = business.id === "import-export";
  return (
    <article
      id={`business-${business.id}`}
      className={`${styles.businessCard} ${featured ? styles.featuredBusiness : ""} ${trade ? styles.tradeBusiness : ""}`}
      data-reveal
    >
      {trade && (
        <>
          <Image
            src="/images/xhyd/trade.webp"
            alt=""
            fill
            sizes="(max-width: 760px) 100vw, (max-width: 1050px) 50vw, 33vw"
          />
          <span className={styles.cardImageShade} aria-hidden="true" />
        </>
      )}
      {featured && (
        <div className={styles.codePattern} aria-hidden="true">
          <span>&lt; / &gt;</span>
        </div>
      )}
      <div className={styles.cardTop}>
        <span className={styles.businessIcon}>
          <Icon size={28} strokeWidth={1.45} aria-hidden="true" />
        </span>
        <span className={styles.businessIndex}>0{index + 1}</span>
      </div>
      <div className={styles.cardCopy}>
        <p className={styles.businessCategory}>{business.category}</p>
        <h3>{business.title}</h3>
        <p>{business.description}</p>
      </div>
      <details className={styles.capabilityDetails}>
        <summary>
          Explore capabilities
          <span className={styles.detailPlus} aria-hidden="true">
            +
          </span>
        </summary>
        <ul>
          {business.capabilities.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
      </details>
    </article>
  );
}

function BusinessSection() {
  return (
    <section
      id="businesses"
      aria-labelledby="businesses-title"
      className={styles.businessSection}
    >
      <Container>
        <div className={styles.sectionHeading} data-reveal>
          <div>
            <Eyebrow>Our business ecosystem</Eyebrow>
            <h2 id="businesses-title">
              Driving growth
              <br />
              across industries<span className={styles.brandPeriod}>.</span>
            </h2>
          </div>
          <p>
            Six complementary divisions.
            <br />A broader world of opportunity.
            <br />
            <span>Explore where we can work together.</span>
          </p>
        </div>
        <div className={styles.businessGrid}>
          {businesses.map((business, index) => (
            <BusinessCard key={business.id} business={business} index={index} />
          ))}
        </div>
      </Container>
    </section>
  );
}

function GlobalPresenceSection() {
  return (
    <section
      id="global-presence"
      aria-labelledby="global-title"
      className={styles.globalSection}
    >
      <Container>
        <div className={styles.globalHeading} data-reveal>
          <div>
            <Eyebrow light>Our global presence</Eyebrow>
            <h2 id="global-title">
              Rooted in China.
              <br />
              <span>Connected to the world.</span>
            </h2>
          </div>
          <p>
            A shared ambition across international markets.
            <br />
            Local perspectives. Global possibilities.
          </p>
        </div>
        <div className={styles.mapWrap} data-reveal>
          <GlobalMap />
        </div>
        <div className={styles.regionGrid}>
          {regions.map((region, index) => (
            <article className={styles.regionCard} key={region.id} data-reveal>
              <div>
                <span className={styles.regionCode}>{region.label}</span>
                <span className={styles.regionNumber}>0{index + 1}</span>
              </div>
              <h3>
                {region.name}
                <span aria-hidden="true">↗</span>
              </h3>
              <p className={styles.regionRole}>{region.role}</p>
              <p>{region.detail}</p>
            </article>
          ))}
        </div>
      </Container>
    </section>
  );
}

function WhyChooseUsSection() {
  return (
    <section
      id="why-xhyd"
      aria-labelledby="why-title"
      className={styles.whySection}
    >
      <Container className={styles.whyGrid}>
        <div className={styles.whyIntro} data-reveal>
          <Eyebrow>Why XHYD</Eyebrow>
          <h2 id="why-title">
            Built for innovation.
            <br />
            <span>Connected for growth.</span>
          </h2>
          <p>
            Business doesn’t happen in isolation.
            <br />
            Neither do we.
          </p>
          <div className={styles.perspectiveVisual}>
            <div className={styles.orbitOne} />
            <div className={styles.orbitTwo} />
            <div className={styles.orbitThree} />
            <div className={styles.orbitCore}>
              <Globe2 size={62} strokeWidth={0.9} aria-hidden="true" />
            </div>
            <span className={styles.orbitLabelOne}>INNOVATION</span>
            <span className={styles.orbitLabelTwo}>CONNECTION</span>
            <span className={styles.orbitLabelThree}>OPPORTUNITY</span>
            <div className={styles.perspectiveCaption}>
              A wider perspective.
              <br />
              <strong>A connected approach.</strong>
            </div>
          </div>
        </div>
        <div className={styles.strengthList}>
          {strengths.map((strength, index) => (
            <article
              className={styles.strengthRow}
              key={strength.title}
              data-reveal
            >
              <span>0{index + 1}</span>
              <div>
                <h3>{strength.title}</h3>
                <p>{strength.description}</p>
              </div>
              <ArrowUpRight size={19} strokeWidth={1.5} aria-hidden="true" />
            </article>
          ))}
        </div>
      </Container>
    </section>
  );
}

const ecosystemSteps = [
  { title: "Technology", description: "Power the idea", Icon: Code2 },
  { title: "Manufacturing", description: "Create the product", Icon: Factory },
  {
    title: "International trade",
    description: "Connect the markets",
    Icon: Ship,
  },
  {
    title: "Distribution",
    description: "Extend the reach",
    Icon: PackageCheck,
  },
  {
    title: "E-commerce",
    description: "Meet the customer",
    Icon: ShoppingBag,
  },
];

function EcosystemSection() {
  return (
    <section
      id="ecosystem"
      aria-labelledby="ecosystem-title"
      className={styles.ecosystemSection}
    >
      <Container>
        <div className={styles.ecosystemHeading} data-reveal>
          <Eyebrow light>Our business ecosystem</Eyebrow>
          <h2 id="ecosystem-title">
            Technology. Manufacturing.
            <br />
            Commerce. <span>Connected.</span>
          </h2>
          <p>
            One ecosystem, built to connect the possibilities at every stage.
          </p>
        </div>
        <ol
          className={styles.ecosystemFlow}
          aria-label="Connected business areas"
        >
          {ecosystemSteps.map(({ title, description, Icon }, index) => (
            <li key={title} data-reveal>
              <div className={styles.flowIcon}>
                <Icon size={30} strokeWidth={1.35} aria-hidden="true" />
                <span>0{index + 1}</span>
              </div>
              <h3>{title}</h3>
              <p>{description}</p>
            </li>
          ))}
        </ol>
        <div className={styles.ecosystemNote}>
          <span aria-hidden="true" />
          <p>
            Different expertise. Shared potential.{" "}
            <strong>The XHYD ecosystem.</strong>
          </p>
        </div>
      </Container>
    </section>
  );
}

function PartnershipSection() {
  return (
    <section
      id="partnerships"
      aria-labelledby="partnership-title"
      className={styles.partnershipSection}
    >
      <Container className={styles.partnershipGrid}>
        <div className={styles.partnershipVisual} data-reveal>
          <Image
            src="/images/xhyd/trade.webp"
            alt="Illustrative aerial view of a container port connecting land and sea trade"
            fill
            sizes="(max-width: 760px) 100vw, 50vw"
          />
          <div className={styles.partnershipImageShade} />
          <div className={styles.partnershipImageText}>
            <Globe2 size={25} strokeWidth={1.4} aria-hidden="true" />
            <p>
              Opportunity has
              <br />
              <strong>no borders.</strong>
            </p>
          </div>
        </div>
        <div className={styles.partnershipCopy} data-reveal>
          <Eyebrow>International partnerships</Eyebrow>
          <h2 id="partnership-title">
            Creating opportunities
            <br />
            <span>across borders.</span>
          </h2>
          <p>
            Good partnerships connect different strengths. We welcome
            conversations with businesses that share our ambition to create,
            trade, and grow across markets.
          </p>
          <ul className={styles.partnerTags}>
            {partnerCategories.map((partner) => (
              <li key={partner}>{partner}</li>
            ))}
          </ul>
          <ActionLink href="#contact">Become a Partner</ActionLink>
        </div>
      </Container>
    </section>
  );
}

function CTASection({
  email,
  contactUrl,
}: {
  email?: string;
  contactUrl?: string;
}) {
  return (
    <section
      id="contact"
      aria-labelledby="contact-title"
      className={styles.contactSection}
    >
      <div className={styles.contactOrbits} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <Container className={styles.contactInner}>
        <div data-reveal>
          <Eyebrow light>The next opportunity starts here</Eyebrow>
          <h2 id="contact-title">
            Let’s shape the future
            <br />
            of business <span>together.</span>
          </h2>
          <p>
            Connect with XHYD to explore new opportunities in technology,
            manufacturing, international trade, and global commerce.
          </p>
          <div className={styles.contactCtas}>
            <PartnershipContact
              email={email}
              contactUrl={contactUrl}
              businesses={businesses}
              regions={regions}
            />
            <ActionLink href="#businesses" variant="outline">
              Explore Our Businesses
            </ActionLink>
          </div>
          {email || contactUrl ? (
            <a
              className={styles.publicContact}
              href={contactUrl || `mailto:${email}`}
            >
              {email || "Visit our contact channel"}
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          ) : (
            <p className={styles.contactAvailability}>
              Prepare a partnership inquiry. Public contact details will be
              available here soon.
            </p>
          )}
        </div>
        <div className={styles.contactMark} aria-hidden="true">
          <Sparkles size={40} strokeWidth={0.8} />
          <span>X</span>
        </div>
      </Container>
    </section>
  );
}

function CorporateFooter({ year }: { year: number }) {
  return (
    <footer className={styles.footer}>
      <Container>
        <div className={styles.footerGrid}>
          <div className={styles.footerBrand}>
            <a href="#home" aria-label="XHYD home">
              <Image
                src="/company_logo.jpeg"
                width={1082}
                height={205}
                alt="XHYD"
                sizes="150px"
              />
            </a>
            <p>
              A multinational business group connecting innovation, industry,
              and international markets.
            </p>
            <span>
              <Globe2 size={14} aria-hidden="true" />
              Headquartered in China. Connected globally.
            </span>
          </div>
          <div>
            <h3>Our businesses</h3>
            <ul>
              {businesses.map((business) => (
                <li key={business.id}>
                  <a href={`#business-${business.id}`}>{business.shortName}</a>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3>Company</h3>
            <ul>
              <li>
                <a href="#about">About XHYD</a>
              </li>
              <li>
                <a href="#businesses">Our Businesses</a>
              </li>
              <li>
                <a href="#global-presence">Global Presence</a>
              </li>
              <li>
                <a href="#why-xhyd">Why XHYD</a>
              </li>
              <li>
                <a href="#contact">Contact</a>
              </li>
            </ul>
          </div>
          <div>
            <h3>Global presence</h3>
            <ul>
              {regions.map((region) => (
                <li key={region.id}>
                  <a href="#global-presence">
                    {region.name}
                    {region.id === "china" && (
                      <span className={styles.hqLabel}>HQ</span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className={styles.footerBottom}>
          <p>© {year} XHYD. All rights reserved.</p>
          <span>Innovation. Industry. International opportunity.</span>
          <a href="/workspace">
            Employee sign in
            <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        </div>
      </Container>
    </footer>
  );
}

export function CorporateHomepage({
  year,
  email,
  contactUrl,
  fontClassName = "",
}: {
  year: number;
  email?: string;
  contactUrl?: string;
  fontClassName?: string;
}) {
  return (
    <div id="xhyd-site" lang="en" className={`${styles.site} ${fontClassName}`}>
      <a href="#main-content" className={styles.skipLink}>
        Skip to main content
      </a>
      <CorporateHeader />
      <main id="main-content" tabIndex={-1}>
        <HeroSection />
        <BusinessRibbon />
        <AboutSection />
        <BusinessSection />
        <GlobalPresenceSection />
        <WhyChooseUsSection />
        <EcosystemSection />
        <PartnershipSection />
        <CTASection email={email} contactUrl={contactUrl} />
      </main>
      <CorporateFooter year={year} />
      <CorporateMotion />
    </div>
  );
}
