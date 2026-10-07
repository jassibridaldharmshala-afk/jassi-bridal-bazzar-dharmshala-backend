const SECTION_DEFAULTS = [
  { id: 'hero', label: 'Hero Section', visible: true, order: 10, heading: 'Where Tradition Meets Modern Grace', description: 'Premium ethnic wear for every celebration.', buttonText: 'Shop New Arrivals', buttonLink: '/products?newArrival=true', image: '', backgroundImage: '' },
  { id: 'services', label: 'Service Highlights', visible: true, order: 15, heading: 'Why Shop With Us', description: 'Shipping, returns and secure payment benefits.', buttonText: '', buttonLink: '', image: '', backgroundImage: '' },
  { id: 'categories', label: 'Featured Categories', visible: true, order: 20, heading: 'Shop by Category', description: 'Curated styles for every occasion.', buttonText: '', buttonLink: '', image: '', backgroundImage: '' },
  { id: 'promotional', label: 'Promotional Banners', visible: true, order: 30, heading: 'Featured Collections', description: '', buttonText: 'Shop Now', buttonLink: '/products', image: '', backgroundImage: '' },
  { id: 'featured', label: 'Featured Products', visible: true, order: 40, heading: 'Featured Products', description: 'A curated edit from the collection.', buttonText: 'View All', buttonLink: '/products?featured=true', image: '', backgroundImage: '' },
  { id: 'newArrivals', label: 'New Arrivals', visible: true, order: 50, heading: 'New Arrivals', description: 'Fresh styles added to the collection.', buttonText: 'View All', buttonLink: '/products?newArrival=true', image: '', backgroundImage: '' },
  { id: 'bestSellers', label: 'Best Sellers', visible: true, order: 60, heading: 'Best Sellers', description: 'Customer favourites from Jassi General Store.', buttonText: 'View All', buttonLink: '/products?bestSeller=true', image: '', backgroundImage: '' },
  { id: 'ethnicSets', label: 'Ethnic Sets', visible: true, order: 64, heading: 'Complete Occasion-Ready Looks', description: 'Coordinated silhouettes for weddings, celebrations, and everyday elegance.', buttonText: 'View All', buttonLink: '/products?search=Set', image: '', backgroundImage: '' },
  { id: 'accessories', label: 'Accessories', visible: true, order: 66, heading: 'The Finishing Touch', description: 'Complete every look with thoughtfully selected accessories.', buttonText: 'View All', buttonLink: '/products?search=Accessory', image: '', backgroundImage: '' },
  { id: 'trending', label: 'Trending Products', visible: true, order: 70, heading: 'Trending Now', description: 'Styles customers are discovering now.', buttonText: 'View All', buttonLink: '/products?trending=true', image: '', backgroundImage: '' },
  { id: 'sale', label: 'Sale Banner', visible: true, order: 80, heading: 'Season Sale', description: 'Discover current offers across the collection.', buttonText: 'View Offers', buttonLink: '/products?discount=20', image: '', backgroundImage: '' },
  { id: 'reviews', label: 'Customer Reviews', visible: true, order: 90, heading: 'Loved by Our Customers', description: 'Real stories from the Jassi community.', buttonText: '', buttonLink: '', image: '', backgroundImage: '' },
  { id: 'newsletter', label: 'Newsletter', visible: true, order: 100, heading: 'Join Jassi Circle', description: 'Get early access to new drops, offers, and styling updates.', buttonText: 'Subscribe', buttonLink: '', image: '', backgroundImage: '' },
  { id: 'instagram', label: 'Instagram / Social', visible: true, order: 110, heading: 'Style Inspiration', description: 'Discover more from our latest collection.', buttonText: 'Explore', buttonLink: '/products', image: '', backgroundImage: '' },
].map((section) => ({ ...section, mobileImage: '', imageAlt: '', imagePosition: 'center' }));

const DEFAULT_WEBSITE_CONFIG = {
  schemaVersion: 2,
  branding: {
    websiteName: 'Jassi General Store',
    tagline: 'Elegance for every celebration',
    logo: '',
    favicon: '',
  },
  colors: {
    primary: '#6d1f34',
    secondary: '#fff0f4',
    accent: '#b8914a',
    background: '#fffaf2',
    surface: '#ffffff',
    text: '#17161a',
    mutedText: '#6f6470',
  },
  header: {
    background: '#fffaf2',
    textColor: '#17161a',
    logoSize: 72,
    menuAlignment: 'left',
    sticky: true,
    announcementEnabled: true,
    announcementText: 'Free Shipping Above ₹999',
    announcementBackground: '#830b31',
    announcementTextColor: '#ffffff',
    announcementLink: '',
    announcementStartsAt: '',
    announcementEndsAt: '',
    menuItems: [
      { label: 'Home', path: '/' },
      { label: 'Shop All', path: '/products' },
      { label: 'New Arrivals', path: '/products?newArrival=true&collection=new-arrivals' },
      { label: 'Best Sellers', path: '/products?bestSeller=true&collection=best-sellers' },
      { label: 'Featured', path: '/products?featured=true&collection=featured' },
      { label: 'Offers', path: '/products?discount=20' },
      { label: 'Contact Us', path: '/contact' },
    ],
  },
  homepage: {
    sections: SECTION_DEFAULTS,
    featuredCategoryIds: [],
    categoryImages: [],
    sectionProductIds: {
      featured: [],
      newArrivals: [],
      bestSellers: [],
      trending: [],
      ethnicSets: [],
      accessories: [],
    },
    blocks: [],
  },
  typography: {
    headingFont: 'Playfair Display',
    bodyFont: 'Inter',
    headingScale: 1,
    bodyScale: 1,
    headingWeight: 700,
    bodyWeight: 400,
    buttonFont: 'Inter',
    buttonWeight: 700,
  },
  buttons: {
    background: '#6d1f34',
    textColor: '#ffffff',
    borderRadius: 8,
    style: 'solid',
    size: 'medium',
    hoverEffect: 'lift',
  },
  productCards: {
    layout: 'classic',
    imageRatio: '4/5',
    borderRadius: 12,
    shadow: 'soft',
    showTitle: true,
    showPrice: true,
    showDiscount: true,
    showRating: true,
    showWishlist: true,
    showAddToCart: true,
    quickView: false,
  },
  footer: {
    enabled: true,
    background: '#4b071b',
    textColor: '#ffffff',
    logo: '',
    description: 'Crafted with elegance, designed for you. Premium ethnic wear for every celebration.',
    showContact: true,
    showSocialLinks: true,
    showNewsletter: true,
    contactEmail: '',
    contactPhone: '',
    contactAddress: '',
    socialLinks: { instagram: '', facebook: '', youtube: '', pinterest: '' },
    menus: {
      shopping: [
        { label: 'New Arrivals', path: '/products?newArrival=true' },
        { label: 'Sarees', path: '/products?search=Saree' },
        { label: 'Suits', path: '/products?search=Suit' },
        { label: 'Accessories', path: '/products?search=Accessory' },
        { label: 'Sale', path: '/products?discount=20' },
      ],
      policies: [
        { label: 'Track Your Order', path: '/orders' },
        { label: 'Returns & Refunds', path: '/returns' },
        { label: 'Shipping Policy', path: '/shipping-policy' },
        { label: 'Contact Us', path: '/contact' },
      ],
      about: [
        { label: 'Our Story', path: '/our-story' },
        { label: 'Reviews', path: '/products?bestSeller=true' },
      ],
    },
    copyrightText: '© Jassi General Store. All rights reserved.',
  },
  layout: {
    mode: 'full',
    maxWidth: 1520,
    sectionSpacing: 72,
    gridGap: 20,
    productsPerRow: { desktop: 4, tablet: 3, mobile: 2 },
  },
  mobile: {
    enabled: false,
    inheritThemeColors: true,
    headerBackground: '#ffffff', headerText: '#334155',
    pageBackground: '#fcfaf7', gridGap: 12, cardRadius: 14, imageRatio: 'original',
    columns: 2, useDesktopCatalog: false,
    showTitle: true, showPrice: true, showDiscount: true, showRating: true, showWishlist: true, showAddToCart: true,
    sections: ['hero', 'services', 'categories', 'sale', 'promotional', 'featured', 'trending', 'newArrivals', 'bestSellers', 'ethnicSets', 'accessories', 'recentlyViewed', 'recommended', 'instagram']
      .map((id, index) => ({ id, visible: true, order: index * 10, heading: '' })),
  },
  tablet: { enabled: false, columns: 3, gridGap: 16 },
  theme: {
    preset: 'default',
    enhancedStyles: false,
  },
};

const PRESET_OVERRIDES = {
  default: {},
  premium: {
    colors: { primary: '#5d142c', secondary: '#f8ece8', accent: '#c79a55', background: '#fffaf5' },
    buttons: { borderRadius: 6, hoverEffect: 'lift' },
    productCards: { borderRadius: 14, shadow: 'elevated' },
    theme: { preset: 'premium' },
  },
  minimal: {
    colors: { primary: '#222222', secondary: '#f4f4f2', accent: '#77746d', background: '#ffffff' },
    typography: { headingFont: 'Inter', headingWeight: 600 },
    buttons: { borderRadius: 2, style: 'outline', hoverEffect: 'darken' },
    productCards: { borderRadius: 2, shadow: 'none', layout: 'minimal' },
    theme: { preset: 'minimal' },
  },
  festive: {
    colors: { primary: '#8d153a', secondary: '#fff0d8', accent: '#d6982f', background: '#fff9ee' },
    header: { announcementBackground: '#9b173f' },
    buttons: { borderRadius: 12, hoverEffect: 'glow' },
    theme: { preset: 'festive' },
  },
  sale: {
    colors: { primary: '#c51f3f', secondary: '#fff0f1', accent: '#ffb020', background: '#fff8f8' },
    header: { announcementBackground: '#c51f3f', announcementText: 'Sale is live — explore current offers' },
    productCards: { shadow: 'elevated' },
    theme: { preset: 'sale' },
  },
  sage: {
    colors: { primary: '#31594c', secondary: '#edf3ed', accent: '#9c8046', background: '#fafbf7' },
    buttons: { borderRadius: 12 }, productCards: { borderRadius: 16, shadow: 'soft' },
    theme: { preset: 'sage' },
  },
  rose: {
    colors: { primary: '#823f58', secondary: '#fbecf0', accent: '#a47b43', background: '#fff9fb' },
    buttons: { borderRadius: 24 }, productCards: { borderRadius: 20, shadow: 'soft' },
    theme: { preset: 'rose' },
  },
  indigo: {
    colors: { primary: '#333b70', secondary: '#eff0f8', accent: '#a18347', background: '#fafaff' },
    typography: { headingFont: 'Georgia' }, buttons: { borderRadius: 6 },
    productCards: { borderRadius: 8, shadow: 'none' }, theme: { preset: 'indigo' },
  },
  wedding: {
    colors: { primary: '#681b36', secondary: '#f8e9e5', accent: '#b88a44', background: '#fffaf5' },
    typography: { headingFont: 'Playfair Display', headingScale: 1.08 },
    buttons: { borderRadius: 999, hoverEffect: 'glow' },
    theme: { preset: 'wedding' },
  },
  pearl: {
    colors: { primary: '#473c36', secondary: '#f2eee8', accent: '#a58153', background: '#fdfbf8' },
    typography: { headingFont: 'Georgia', headingWeight: 400 },
    buttons: { borderRadius: 4, style: 'solid', hoverEffect: 'darken' },
    productCards: { borderRadius: 8, shadow: 'none', layout: 'minimal', imageRatio: '4/5' },
    theme: { preset: 'pearl' },
  },
  midnight: {
    colors: { primary: '#242b45', secondary: '#edf0f6', accent: '#aa8552', background: '#fafbfe' },
    typography: { headingFont: 'Playfair Display', headingWeight: 600 },
    buttons: { borderRadius: 8, style: 'solid', hoverEffect: 'lift' },
    productCards: { borderRadius: 12, shadow: 'soft', layout: 'classic', imageRatio: '3/4' },
    theme: { preset: 'midnight' },
  },
  champagne: {
    colors: { primary: '#6c5139', secondary: '#f6eddf', accent: '#b58e56', background: '#fffdf7' },
    typography: { headingFont: 'Georgia', headingWeight: 400 },
    buttons: { borderRadius: 999, style: 'solid', hoverEffect: 'darken' },
    productCards: { borderRadius: 16, shadow: 'soft', layout: 'classic', imageRatio: '4/5' },
    theme: { preset: 'champagne' },
  },
  terracotta: {
    colors: { primary: '#904832', secondary: '#faeee5', accent: '#b18856', background: '#fffaf5' },
    typography: { headingFont: 'Georgia', headingWeight: 700 },
    buttons: { borderRadius: 12, style: 'solid', hoverEffect: 'lift' },
    productCards: { borderRadius: 16, shadow: 'none', layout: 'classic', imageRatio: '4/5' },
    theme: { preset: 'terracotta' },
  },
  emerald: {
    colors: { primary: '#174e42', secondary: '#edf4ef', accent: '#b28a4b', background: '#fbfdf9' },
    typography: { headingFont: 'Playfair Display', headingWeight: 600 },
    buttons: { borderRadius: 6, style: 'solid', hoverEffect: 'darken' },
    productCards: { borderRadius: 10, shadow: 'soft', layout: 'classic', imageRatio: '3/4' },
    theme: { preset: 'emerald' },
  },
  lilac: {
    colors: { primary: '#644678', secondary: '#f2edf7', accent: '#a18465', background: '#fdfaff' },
    typography: { headingFont: 'Inter', headingWeight: 600 },
    buttons: { borderRadius: 24, style: 'solid', hoverEffect: 'lift' },
    productCards: { borderRadius: 20, shadow: 'soft', layout: 'classic', imageRatio: '4/5' },
    theme: { preset: 'lilac' },
  },
  coastal: {
    colors: { primary: '#32616a', secondary: '#eaf3f2', accent: '#aa895a', background: '#fafdfa' },
    typography: { headingFont: 'Georgia', headingWeight: 400 },
    buttons: { borderRadius: 8, style: 'outline', hoverEffect: 'none' },
    productCards: { borderRadius: 8, shadow: 'none', layout: 'minimal', imageRatio: '4/5' },
    theme: { preset: 'coastal' },
  },
  graphite: {
    colors: { primary: '#30343b', secondary: '#eef0f2', accent: '#787f8b', background: '#ffffff' },
    typography: { headingFont: 'Inter', headingWeight: 600 },
    buttons: { borderRadius: 8, style: 'solid', hoverEffect: 'darken' },
    productCards: { borderRadius: 10, shadow: 'none', layout: 'compact', imageRatio: '4/5' },
    theme: { preset: 'graphite' },
  },
  mobileTech: {
    colors: { primary: '#1557d0', secondary: '#edf4ff', accent: '#16a3a6', background: '#f7f9fc' },
    typography: { headingFont: 'Inter', headingWeight: 700 }, buttons: { borderRadius: 10, hoverEffect: 'lift' },
    productCards: { borderRadius: 14, shadow: 'soft', layout: 'compact', imageRatio: '1/1' }, theme: { preset: 'mobileTech' },
  },
  jewelleryLuxe: {
    colors: { primary: '#49351f', secondary: '#f8f0df', accent: '#c49646', background: '#fffdf7' },
    typography: { headingFont: 'Playfair Display', headingWeight: 600 }, buttons: { borderRadius: 999, hoverEffect: 'glow' },
    productCards: { borderRadius: 18, shadow: 'elevated', layout: 'minimal', imageRatio: '1/1' }, theme: { preset: 'jewelleryLuxe' },
  },
  beautyGlow: {
    colors: { primary: '#8a3d68', secondary: '#faedf5', accent: '#ca8b73', background: '#fffafd' },
    typography: { headingFont: 'Georgia', headingWeight: 400 }, buttons: { borderRadius: 24, hoverEffect: 'lift' },
    productCards: { borderRadius: 22, shadow: 'soft', layout: 'classic', imageRatio: '1/1' }, theme: { preset: 'beautyGlow' },
  },
  homeWarm: {
    colors: { primary: '#4f5a43', secondary: '#eef0e8', accent: '#a7724d', background: '#fbfaf6' },
    typography: { headingFont: 'Georgia', headingWeight: 400 }, buttons: { borderRadius: 8, hoverEffect: 'darken' },
    productCards: { borderRadius: 12, shadow: 'none', layout: 'minimal', imageRatio: '1/1' }, theme: { preset: 'homeWarm' },
  },
};

const PRESET_LABELS = {
  default: 'Default Theme',
  premium: 'Premium Theme',
  minimal: 'Minimal Theme',
  festive: 'Festive Theme',
  sale: 'Sale Theme',
  wedding: 'Wedding Theme',
  sage: 'Botanical Sage', rose: 'Soft Rose', indigo: 'Indigo Heritage',
  pearl: 'Pearl Atelier',
  midnight: 'Midnight Studio',
  champagne: 'Champagne Edit',
  terracotta: 'Terracotta Muse',
  emerald: 'Emerald Luxe',
  lilac: 'Lilac Bloom',
  coastal: 'Coastal Linen',
  graphite: 'Modern Graphite',
  mobileTech: 'Mobile Tech Pro',
  jewelleryLuxe: 'Jewellery Luxe',
  beautyGlow: 'Beauty Glow',
  homeWarm: 'Warm Home',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeKnown(base, incoming) {
  if (Array.isArray(base)) return Array.isArray(incoming) ? clone(incoming) : clone(base);
  if (!base || typeof base !== 'object') {
    if (typeof base === 'boolean') return typeof incoming === 'boolean' ? incoming : base;
    if (typeof base === 'number') return Number.isFinite(Number(incoming)) ? Number(incoming) : base;
    return typeof incoming === 'string' || typeof incoming === 'number' ? String(incoming).slice(0, 5000) : base;
  }
  const source = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  return Object.fromEntries(Object.entries(base).map(([key, value]) => [key, mergeKnown(value, source[key])]));
}

function normalizeSections(sections) {
  const source = Array.isArray(sections) ? sections : [];
  const sourceMap = new Map(source.filter((section) => section && typeof section === 'object').map((section) => [String(section.id || ''), section]));
  return SECTION_DEFAULTS.map((fallback, index) => {
    const section = mergeKnown(fallback, sourceMap.get(fallback.id));
    section.id = fallback.id;
    section.label = fallback.label;
    section.visible = typeof section.visible === 'boolean' ? section.visible : true;
    section.order = Math.max(0, Math.min(1000, Number(section.order ?? (index + 1) * 10)));
    section.buttonLink = safeInternalPath(section.buttonLink);
    section.image = safeImageUrl(section.image);
    section.mobileImage = safeImageUrl(section.mobileImage);
    section.imageAlt = cleanText(section.imageAlt, 180);
    section.imagePosition = oneOf(section.imagePosition, ['top', 'center', 'bottom'], 'center');
    section.backgroundImage = safeImageUrl(section.backgroundImage);
    return section;
  }).sort((a, b) => a.order - b.order);
}

const BLOCK_TYPES = ['hero', 'image-text', 'offer', 'trust', 'faq', 'video', 'product-grid', 'category-grid', 'category-carousel', 'reviews', 'newsletter', 'social', 'countdown', 'coupon'];
function normalizeBlocks(blocks) {
  const used = new Set();
  return (Array.isArray(blocks) ? blocks : []).slice(0, 24).map((input, index) => {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    let id = cleanText(source.id, 80).replace(/[^a-zA-Z0-9_-]/g, '') || `block-${index + 1}`;
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    return {
      id,
      type: oneOf(source.type, BLOCK_TYPES, 'image-text'),
      visible: source.visible !== false,
      showOnDesktop: source.showOnDesktop !== false,
      showOnMobile: source.showOnMobile !== false,
      order: bounded(source.order, 0, 2000, 120 + index * 10),
      eyebrow: cleanText(source.eyebrow, 80),
      title: cleanText(source.title, 140),
      body: cleanText(source.body, 1200),
      buttonText: cleanText(source.buttonText, 80),
      buttonLink: safeInternalPath(source.buttonLink),
      image: safeImageUrl(source.image),
      mobileImage: safeImageUrl(source.mobileImage),
      altText: cleanText(source.altText, 180),
      videoUrl: safeMediaUrl(source.videoUrl),
      couponCode: cleanText(source.couponCode, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, ''),
      endsAt: safeDate(source.endsAt),
      alignment: oneOf(source.alignment, ['left', 'center', 'right'], 'left'),
      imagePosition: oneOf(source.imagePosition, ['top', 'center', 'bottom'], 'center'),
      backgroundColor: validOptionalColor(source.backgroundColor),
      textColor: validOptionalColor(source.textColor),
      productIds: normalizeIds(source.productIds).slice(0, 12),
      categoryIds: normalizeIds(source.categoryIds).slice(0, 8),
      items: (Array.isArray(source.items) ? source.items : []).slice(0, 8).map((item) => cleanText(item, 160)).filter(Boolean),
    };
  }).sort((left, right) => left.order - right.order);
}

function validColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : fallback;
}

function oneOf(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function normalizeWebsiteConfig(input = {}) {
  const sourceVersion = Number(input?.schemaVersion || 0);
  const config = mergeKnown(DEFAULT_WEBSITE_CONFIG, input);
  if (sourceVersion < 2) config.header.sticky = true;
  config.schemaVersion = 2;
  config.branding.websiteName = cleanText(config.branding.websiteName, 120) || DEFAULT_WEBSITE_CONFIG.branding.websiteName;
  config.branding.tagline = cleanText(config.branding.tagline, 240);
  config.branding.logo = safeImageUrl(config.branding.logo);
  config.branding.favicon = safeImageUrl(config.branding.favicon);
  config.header.announcementLink = safeInternalPath(config.header.announcementLink);
  config.header.announcementStartsAt = safeDate(config.header.announcementStartsAt);
  config.header.announcementEndsAt = safeDate(config.header.announcementEndsAt);
  config.header.menuItems = normalizeMenu(config.header.menuItems).slice(0, 8);
  config.footer.logo = safeImageUrl(config.footer.logo);
  config.homepage.sections = normalizeSections(input?.homepage?.sections || config.homepage.sections);
  config.homepage.featuredCategoryIds = normalizeIds(config.homepage.featuredCategoryIds);
  Object.keys(config.homepage.sectionProductIds).forEach((key) => {
    config.homepage.sectionProductIds[key] = normalizeIds(config.homepage.sectionProductIds[key]);
  });
  config.homepage.categoryImages = (Array.isArray(config.homepage.categoryImages) ? config.homepage.categoryImages : [])
    .slice(0, 50)
    .map((item) => ({ categoryId: cleanText(item?.categoryId, 100), image: safeImageUrl(item?.image) }))
    .filter((item) => item.categoryId && item.image);
  config.homepage.blocks = normalizeBlocks(input?.homepage?.blocks || config.homepage.blocks);
  Object.keys(config.footer.socialLinks).forEach((key) => { config.footer.socialLinks[key] = safeExternalUrl(config.footer.socialLinks[key]); });
  Object.keys(config.footer.menus).forEach((key) => { config.footer.menus[key] = normalizeMenu(config.footer.menus[key]); });

  Object.keys(config.colors).forEach((key) => { config.colors[key] = validColor(config.colors[key], DEFAULT_WEBSITE_CONFIG.colors[key]); });
  for (const key of ['background', 'textColor', 'announcementBackground', 'announcementTextColor']) {
    config.header[key] = validColor(config.header[key], DEFAULT_WEBSITE_CONFIG.header[key]);
  }
  for (const key of ['background', 'textColor']) config.footer[key] = validColor(config.footer[key], DEFAULT_WEBSITE_CONFIG.footer[key]);
  for (const key of ['background', 'textColor']) config.buttons[key] = validColor(config.buttons[key], DEFAULT_WEBSITE_CONFIG.buttons[key]);

  config.header.logoSize = bounded(config.header.logoSize, 36, 140, DEFAULT_WEBSITE_CONFIG.header.logoSize);
  config.header.menuAlignment = oneOf(config.header.menuAlignment, ['left', 'center', 'right'], 'left');
  config.typography.headingFont = oneOf(config.typography.headingFont, ['Playfair Display', 'Inter', 'Georgia', 'Arial'], 'Playfair Display');
  config.typography.bodyFont = oneOf(config.typography.bodyFont, ['Inter', 'Figtree', 'Georgia', 'Arial'], 'Inter');
  config.typography.buttonFont = oneOf(config.typography.buttonFont, ['Inter', 'Figtree', 'Georgia', 'Arial'], 'Inter');
  config.typography.headingScale = bounded(config.typography.headingScale, 0.75, 1.5, 1);
  config.typography.bodyScale = bounded(config.typography.bodyScale, 0.8, 1.3, 1);
  config.typography.headingWeight = bounded(config.typography.headingWeight, 400, 900, 700);
  config.typography.bodyWeight = bounded(config.typography.bodyWeight, 300, 700, 400);
  config.typography.buttonWeight = bounded(config.typography.buttonWeight, 400, 900, 700);
  config.buttons.borderRadius = bounded(config.buttons.borderRadius, 0, 999, 8);
  config.buttons.style = oneOf(config.buttons.style, ['solid', 'outline', 'soft'], 'solid');
  config.buttons.size = oneOf(config.buttons.size, ['small', 'medium', 'large'], 'medium');
  config.buttons.hoverEffect = oneOf(config.buttons.hoverEffect, ['none', 'lift', 'darken', 'glow'], 'lift');
  config.productCards.layout = oneOf(config.productCards.layout, ['classic', 'minimal', 'compact'], 'classic');
  config.productCards.imageRatio = oneOf(config.productCards.imageRatio, ['1/1', '4/5', '3/4'], '4/5');
  config.productCards.borderRadius = bounded(config.productCards.borderRadius, 0, 32, 12);
  config.productCards.shadow = oneOf(config.productCards.shadow, ['none', 'soft', 'elevated'], 'soft');
  config.layout.mode = oneOf(config.layout.mode, ['full', 'boxed'], 'full');
  config.layout.maxWidth = bounded(config.layout.maxWidth, 960, 1920, 1520);
  config.layout.sectionSpacing = bounded(config.layout.sectionSpacing, 16, 160, 72);
  config.layout.gridGap = bounded(config.layout.gridGap, 4, 64, 20);
  config.layout.productsPerRow.desktop = bounded(config.layout.productsPerRow.desktop, 2, 6, 4);
  config.layout.productsPerRow.tablet = bounded(config.layout.productsPerRow.tablet, 2, 5, 3);
  config.layout.productsPerRow.mobile = bounded(config.layout.productsPerRow.mobile, 1, 3, 2);
  config.mobile.sections = DEFAULT_WEBSITE_CONFIG.mobile.sections.map((fallback) => {
    const source = (Array.isArray(input?.mobile?.sections) ? input.mobile.sections : []).find((section) => section?.id === fallback.id);
    const section = mergeKnown(fallback, source);
    return { ...section, id: fallback.id, order: bounded(section.order, 0, 1000, fallback.order), heading: cleanText(section.heading, 120) };
  }).sort((a, b) => a.order - b.order);
  for (const key of ['headerBackground', 'headerText', 'pageBackground']) config.mobile[key] = validColor(config.mobile[key], DEFAULT_WEBSITE_CONFIG.mobile[key]);
  config.mobile.columns = Math.round(bounded(config.mobile.columns, 1, 2, 2));
  config.mobile.gridGap = bounded(config.mobile.gridGap, 8, 24, 12);
  config.mobile.cardRadius = bounded(config.mobile.cardRadius, 0, 24, 14);
  config.mobile.imageRatio = oneOf(config.mobile.imageRatio, ['original', '1/1', '4/5', '3/4'], 'original');
  for (const key of ['showTitle', 'showPrice', 'showDiscount', 'showRating', 'showWishlist', 'showAddToCart']) {
    config.mobile[key] = typeof config.mobile[key] === 'boolean' ? config.mobile[key] : true;
  }
  config.tablet.columns = Math.round(bounded(config.tablet.columns, 2, 4, 3));
  config.tablet.gridGap = bounded(config.tablet.gridGap, 8, 32, 16);
  config.layout.productsPerRow.desktop = Math.round(config.layout.productsPerRow.desktop);
  config.theme.preset = oneOf(config.theme.preset, Object.keys(PRESET_OVERRIDES), 'default');
  return config;
}

function cleanText(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function normalizeIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => cleanText(item, 100)).filter(Boolean))].slice(0, 100);
}

function safeImageUrl(value) {
  const url = cleanText(value, 2000);
  return /^(https?:\/\/|\/(?!\/))[^\\\s]*$/i.test(url) ? url : '';
}

function safeExternalUrl(value) {
  const url = cleanText(value, 2000);
  return !url || /^https:\/\//i.test(url) ? url : '';
}

function safeMediaUrl(value) {
  const url = cleanText(value, 2000);
  if (!url) return '';
  if (!/^(https?:\/\/|\/(?!\/))[^\\\s]*$/i.test(url)) return '';
  return /\.(mp4|webm)(?:[?#].*)?$/i.test(url) ? url : '';
}

function safeDate(value) {
  const text = cleanText(value, 40);
  if (!text) return '';
  const timestamp = new Date(text).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function validOptionalColor(value) {
  const color = cleanText(value, 20);
  return !color || /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '';
}

function safeInternalPath(value) {
  const path = cleanText(value, 500);
  return !path || (/^\/(?!\/)/.test(path) && !/[\\\s]/.test(path)) ? path : '';
}

function normalizeMenu(value) {
  return (Array.isArray(value) ? value : []).slice(0, 20).map((item) => ({
    label: cleanText(item?.label, 80),
    path: safeInternalPath(item?.path),
  })).filter((item) => item.label && /^\/(?!\/)/.test(item.path));
}

function buildPresetConfig(preset = 'default') {
  const config = normalizeWebsiteConfig(mergeKnown(DEFAULT_WEBSITE_CONFIG, PRESET_OVERRIDES[preset] || {}));
  if (preset !== 'default') {
    config.theme.enhancedStyles = true;
    config.header.background = config.colors.background;
    config.header.textColor = config.colors.text;
    config.header.announcementBackground = config.colors.primary;
    config.buttons.background = config.colors.primary;
    config.footer.background = config.colors.primary;
  }
  return config;
}

function getPresetList({ appearanceOnly = false } = {}) {
  const descriptions = {
    default: 'The original Jassi wine and ivory look.',
    premium: 'Rich wine, warm gold and elevated cards.',
    minimal: 'Clean monochrome with understated borders.',
    festive: 'Celebratory ruby and golden accents.',
    sale: 'A bold berry palette for your offer collections.',
    wedding: 'Elegant serif headings with rounded buttons.',
    sage: 'Calm green, warm neutrals and soft corners.',
    rose: 'Blush tones and softly rounded cards.',
    indigo: 'Classic blue with subtle gold accents.',
    pearl: 'Warm ivory, delicate serif type and quiet borders.',
    midnight: 'Deep navy, portrait cards and polished details.',
    champagne: 'Soft gold, warm neutrals and elegant curves.',
    terracotta: 'Earthy clay tones with a relaxed editorial feel.',
    emerald: 'Jewel green and gold for occasion collections.',
    lilac: 'Airy lavender, modern type and soft corners.',
    coastal: 'Linen whites, muted teal and fine outlines.',
    graphite: 'Crisp monochrome and compact contemporary cards.',
    mobileTech: 'Clean blue commerce styling for phones and electronics.',
    jewelleryLuxe: 'Warm gold and editorial styling for jewellery catalogues.',
    beautyGlow: 'Soft rose presentation for beauty and cosmetics stores.',
    homeWarm: 'Natural neutrals for home, decor and lifestyle products.',
  };
  const collections = {
    default: 'Signature', premium: 'Signature', indigo: 'Signature',
    minimal: 'Minimal', festive: 'Celebration', sale: 'Celebration', wedding: 'Celebration',
    sage: 'Nature', rose: 'Nature',
    pearl: 'Minimal',
    midnight: 'Signature',
    champagne: 'Celebration',
    terracotta: 'Nature',
    emerald: 'Celebration',
    lilac: 'Nature',
    coastal: 'Nature',
    graphite: 'Minimal',
    mobileTech: 'Industry', jewelleryLuxe: 'Industry', beautyGlow: 'Industry', homeWarm: 'Industry',
  };
  const industries = {
    mobileTech: ['mobile', 'electronics'], jewelleryLuxe: ['jewellery'], beautyGlow: ['cosmetics'], homeWarm: ['home'],
  };
  return Object.keys(PRESET_OVERRIDES).map((id) => {
    const config = buildPresetConfig(id);
    // Avoid repeating default catalog, menus and home content in gallery entries.
    // The full configuration remains the default for existing API consumers.
    const appearance = appearanceOnly ? {
      schemaVersion: config.schemaVersion, colors: config.colors, typography: config.typography,
      buttons: config.buttons, productCards: config.productCards, theme: config.theme,
      header: Object.fromEntries(['background', 'textColor', 'announcementBackground', 'announcementTextColor'].map((key) => [key, config.header[key]])),
      footer: { background: config.footer.background, textColor: config.footer.textColor },
    } : config;
    return { id, name: PRESET_LABELS[id], description: descriptions[id], collection: collections[id], recommendedFor: industries[id] || ['all'],
      swatches: { primary: config.colors.primary, secondary: config.colors.secondary, accent: config.colors.accent, background: config.colors.background }, config: appearance };
  });
}

module.exports = {
  BLOCK_TYPES,
  DEFAULT_WEBSITE_CONFIG,
  SECTION_DEFAULTS,
  buildPresetConfig,
  getPresetList,
  normalizeWebsiteConfig,
};
