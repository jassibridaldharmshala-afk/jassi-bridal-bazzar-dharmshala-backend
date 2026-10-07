const ATTRIBUTE_TYPES = Object.freeze(['text', 'number', 'dropdown', 'multi_select', 'boolean', 'color', 'date', 'textarea', 'measurement', 'range', 'image']);

const attribute = (key, label, type = 'text', config = {}) => ({
  key, label, type, unit: '', required: false, filterable: false, searchable: true,
  showOnCard: false, showOnDetail: true, showInSpecifications: true, variant: false,
  options: [], defaultValue: '', sortOrder: 0, group: 'Specifications', validation: {}, ...config,
});
const choice = (key, label, options, config = {}) => attribute(key, label, 'dropdown', { options, ...config });
const measure = (key, label, unit, config = {}) => attribute(key, label, 'measurement', { unit, ...config });
const category = (key, name, parentKey = '', config = {}) => ({
  key, name, parentKey, active: true, attributes: [], ...config,
  variantAttributes: config.variantAttributes || (config.attributes || []).filter((item) => item?.variant).map((item) => item.key),
  filters: config.filters || (config.attributes || []).filter((item) => item?.filterable).map((item) => item.key),
});

function preset({ id, name, sizing = false, attributes, categories, categoryDefinitions = [], filters, sections, variants = [], features = {}, inventory = {}, delivery = {}, returns = {}, productSections = [], commerce = { mode: 'SALE_ONLY' } }) {
  return {
    id, name, industry: id, version: 2, active: true,
    commerce: { ...commerce, rentalModuleVersion: 1, stockMode: 'SEPARATE_RENTAL_ASSETS' },
    features: { sizing, specifications: true, comparison: false, perishable: false, customization: false, technical: false, ...features },
    attributes: attributes.map((item, index) => ({ ...item, sortOrder: item.sortOrder || index + 1 })),
    defaultCategories: categories,
    categoryDefinitions,
    filters: filters.map((item) => typeof item === 'string' ? { key: item, label: title(item), type: 'value', enabled: true } : item),
    sortingOptions: [
      { key: 'newest', label: 'Newest first' }, { key: 'bestSeller', label: 'Popularity' },
      { key: 'priceLowHigh', label: 'Price: low to high' }, { key: 'priceHighLow', label: 'Price: high to low' },
      { key: 'discount', label: 'Best discount' }, { key: 'rating', label: 'Customer rating' },
    ],
    measurementUnits: ['piece', 'g', 'kg', 'ml', 'l', 'cm', 'in'],
    variantConfig: { enabled: variants.length > 0, attributes: variants, autoGenerate: false, maxCombinations: 120, skuPattern: '{base}-{options}' },
    productSections: productSections.length ? productSections : ['overview', 'specifications', 'delivery', 'returns', 'reviews'],
    productCard: { fields: ['name', 'price', 'discountPercentage'], attributeKeys: attributes.filter((item) => item.showOnCard).slice(0, 2).map((item) => item.key) },
    inventory: { mode: variants.length ? 'variant' : 'product', trackExpiry: false, allowBackorder: false, lowStockDefault: 5, ...inventory },
    delivery: { requiresWeight: true, supportsScheduledDelivery: false, supportsLocalOnly: false, ...delivery },
    returns: { mode: 'return', defaultWindowDays: 7, nonReturnableWhenCustomized: false, ...returns },
    seo: { titlePattern: '{product} | {store}', descriptionAttributes: attributes.filter((item) => item.searchable).slice(0, 5).map((item) => item.key) },
    homepageSections: sections,
    recommendationGroups: ['same-category', 'similar-price', 'recently-viewed'],
    badges: ['new', 'best-seller', 'featured', 'low-stock'],
  };
}

const fashionAttributes = [
  choice('gender', 'Gender', ['Women', 'Men', 'Girls', 'Boys', 'Unisex'], { filterable: true, showOnCard: true, group: 'Style' }),
  choice('clothing_type', 'Clothing type', ['Saree', 'Kurta Set', 'Dress', 'Top', 'Bottomwear', 'Co-ord Set', 'Lehenga', 'Accessory'], { filterable: true, group: 'Style' }),
  choice('size', 'Size', ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', 'Free Size'], { filterable: true, variant: true, group: 'Variants' }),
  attribute('colour', 'Colour', 'color', { filterable: true, variant: true, showOnCard: true, group: 'Variants' }),
  choice('material', 'Material', ['Cotton', 'Silk', 'Georgette', 'Rayon', 'Linen', 'Denim', 'Velvet', 'Net', 'Synthetic'], { filterable: true, group: 'Material & care' }),
  choice('fit', 'Fit', ['Regular', 'Slim', 'Relaxed', 'Oversized', 'Tailored'], { filterable: true, group: 'Style' }),
  choice('pattern', 'Pattern', ['Solid', 'Printed', 'Embroidered', 'Striped', 'Checked', 'Woven'], { filterable: true, group: 'Style' }),
  choice('sleeve_type', 'Sleeve type', ['Sleeveless', 'Short', 'Half', 'Three-quarter', 'Long'], { group: 'Style' }),
  choice('neckline', 'Neckline', ['Round', 'V-Neck', 'Square', 'Boat', 'Collared', 'Sweetheart'], { group: 'Style' }),
  choice('occasion', 'Occasion', ['Casual', 'Work', 'Festive', 'Wedding', 'Party', 'Sports'], { filterable: true, group: 'Style' }),
  attribute('fabric', 'Fabric', 'text', { filterable: true, group: 'Material & care' }),
  attribute('wash_care', 'Wash care', 'textarea', { group: 'Material & care' }),
  attribute('country_of_origin', 'Country of origin', 'text', { group: 'Manufacturing' }),
];

const mobileAttributes = [
  attribute('brand', 'Brand', 'text', { required: true, filterable: true, showOnCard: true, group: 'Identity' }),
  attribute('model', 'Model', 'text', { required: true, group: 'Identity' }),
  attribute('gtin', 'GTIN / EAN / UPC', 'text', { group: 'Product identifiers', validation: { minLength: 8, maxLength: 14 } }),
  attribute('mpn', 'Manufacturer part number', 'text', { group: 'Product identifiers' }),
  choice('condition', 'Condition', ['New', 'Refurbished', 'Used'], { required: true, filterable: true, showOnCard: true, group: 'Identity' }),
  attribute('colour', 'Colour', 'color', { filterable: true, variant: true, group: 'Variants' }),
  attribute('compatible_devices', 'Compatible devices / models', 'textarea', { searchable: true, group: 'Compatibility' }),
  attribute('manufacturer', 'Manufacturer', 'text', { group: 'Manufacturing' }),
  attribute('country_of_origin', 'Country of origin', 'text', { group: 'Manufacturing' }),
  attribute('warranty', 'Warranty period', 'text', { required: true, filterable: true, group: 'Warranty' }),
  choice('warranty_type', 'Warranty type', ['Manufacturer', 'Seller', 'International', 'No warranty'], { filterable: true, group: 'Warranty' }),
  attribute('warranty_terms', 'Warranty terms and exclusions', 'textarea', { group: 'Warranty' }),
  attribute('box_contents', 'Box contents', 'textarea', { group: 'Package' }),
  attribute('dimensions', 'Dimensions', 'text', { group: 'Physical' }),
  measure('weight', 'Weight', 'g', { group: 'Physical' }),
  attribute('regulatory_certification', 'BIS / regulatory certification', 'text', { group: 'Compliance' }),
];

const smartphoneAttributes = [
  choice('ram', 'RAM', ['2', '3', '4', '6', '8', '12', '16', '24'], { unit: 'GB', filterable: true, variant: true, showOnCard: true, group: 'Performance' }),
  choice('storage', 'Storage', ['32', '64', '128', '256', '512', '1024'], { unit: 'GB', filterable: true, variant: true, group: 'Performance' }),
  attribute('processor', 'Processor / chipset', 'text', { required: true, filterable: true, group: 'Performance' }),
  attribute('cpu_details', 'CPU and GPU details', 'text', { group: 'Performance' }),
  measure('display_size', 'Display size', 'in', { filterable: true, group: 'Display' }),
  choice('display_type', 'Display type', ['LCD', 'IPS LCD', 'OLED', 'AMOLED', 'Super AMOLED'], { filterable: true, group: 'Display' }),
  attribute('display_resolution', 'Display resolution', 'text', { filterable: true, group: 'Display' }),
  measure('refresh_rate', 'Refresh rate', 'Hz', { filterable: true, group: 'Display' }),
  attribute('display_protection', 'Display protection', 'text', { group: 'Display' }),
  measure('battery', 'Battery capacity', 'mAh', { group: 'Battery' }),
  measure('charging_power', 'Fast charging power', 'W', { filterable: true, group: 'Battery' }),
  attribute('wireless_charging', 'Wireless charging', 'boolean', { filterable: true, group: 'Battery' }),
  attribute('rear_camera', 'Rear camera', 'text', { group: 'Camera' }),
  attribute('front_camera', 'Front camera', 'text', { group: 'Camera' }),
  attribute('camera_features', 'Camera features', 'textarea', { group: 'Camera' }),
  attribute('video_recording', 'Video recording', 'text', { group: 'Camera' }),
  attribute('operating_system', 'Operating system', 'text', { filterable: true, group: 'Software' }),
  attribute('os_version', 'OS version and update promise', 'text', { group: 'Software' }),
  choice('network_type', 'Network type', ['4G', '5G'], { filterable: true, group: 'Connectivity' }),
  attribute('network_bands', 'Supported network bands', 'textarea', { group: 'Connectivity' }),
  choice('sim_type', 'SIM type', ['Single SIM', 'Dual SIM', 'eSIM', 'Dual SIM + eSIM'], { group: 'Connectivity' }),
  choice('device_lock', 'Network lock', ['Unlocked', 'Carrier locked'], { filterable: true, group: 'Connectivity' }),
  attribute('wifi', 'Wi-Fi', 'text', { group: 'Connectivity' }),
  attribute('bluetooth', 'Bluetooth', 'text', { group: 'Connectivity' }),
  attribute('nfc', 'NFC', 'boolean', { filterable: true, group: 'Connectivity' }),
  attribute('usb', 'USB / connector', 'text', { group: 'Connectivity' }),
  attribute('gps', 'GPS', 'boolean', { group: 'Connectivity' }),
  attribute('expandable_storage', 'Expandable storage', 'text', { group: 'Memory' }),
  attribute('ip_rating', 'Water and dust resistance', 'text', { filterable: true, group: 'Durability' }),
  attribute('security_features', 'Biometric and security features', 'textarea', { group: 'Security' }),
  attribute('sensors', 'Sensors', 'textarea', { group: 'Sensors' }),
  attribute('sar_value', 'SAR value', 'text', { group: 'Compliance' }),
];

const featurePhoneAttributes = [
  choice('storage', 'Storage', ['4', '8', '16', '32', '64', '128'], { unit: 'GB', filterable: true, variant: true, group: 'Performance' }),
  measure('display_size', 'Display size', 'in', { filterable: true, group: 'Display' }),
  measure('battery', 'Battery capacity', 'mAh', { group: 'Battery' }),
  attribute('rear_camera', 'Camera', 'text', { group: 'Camera' }),
  choice('network_type', 'Network type', ['2G', '3G', '4G'], { filterable: true, group: 'Connectivity' }),
  choice('sim_type', 'SIM type', ['Single SIM', 'Dual SIM'], { group: 'Connectivity' }),
  attribute('expandable_storage', 'Expandable storage', 'text', { group: 'Memory' }),
  attribute('fm_radio', 'FM radio', 'boolean', { group: 'Features' }),
  attribute('torch', 'Torch', 'boolean', { group: 'Features' }),
];

const caseAttributes = [
  choice('case_type', 'Case / protection type', ['Back cover', 'Flip cover', 'Bumper', 'Pouch', 'Screen protector', 'Camera protector'], { required: true, filterable: true, group: 'Design' }),
  attribute('material', 'Material', 'text', { required: true, filterable: true, group: 'Design' }),
  attribute('protection_features', 'Protection features', 'textarea', { group: 'Protection' }),
  attribute('wireless_charging_compatible', 'Wireless charging compatible', 'boolean', { filterable: true, group: 'Compatibility' }),
];

const chargerAttributes = [
  choice('charger_type', 'Charger type', ['Wall charger', 'Car charger', 'Wireless charger', 'Power bank', 'Cable'], { required: true, filterable: true, group: 'Power' }),
  measure('output_power', 'Maximum output', 'W', { required: true, filterable: true, group: 'Power' }),
  attribute('ports', 'Ports and quantity', 'text', { filterable: true, group: 'Connectivity' }),
  attribute('connector_type', 'Connector type', 'multi_select', { options: ['USB-C', 'USB-A', 'Lightning', 'Micro USB'], filterable: true, variant: true, group: 'Connectivity' }),
  attribute('charging_protocols', 'Charging protocols', 'multi_select', { options: ['USB PD', 'PPS', 'Quick Charge', 'VOOC', 'SuperVOOC', 'Adaptive Fast Charging'], filterable: true, group: 'Power' }),
  attribute('cable_included', 'Cable included', 'boolean', { group: 'Package' }),
];

const earphoneAttributes = [
  choice('earphone_type', 'Earphone type', ['True wireless', 'Neckband', 'Over-ear', 'On-ear', 'Wired in-ear'], { required: true, filterable: true, group: 'Design' }),
  choice('connectivity', 'Connectivity', ['Bluetooth', '3.5 mm', 'USB-C', 'Lightning'], { required: true, filterable: true, group: 'Connectivity' }),
  measure('driver_size', 'Driver size', 'mm', { group: 'Audio' }),
  measure('battery_life', 'Battery life', 'hours', { filterable: true, group: 'Battery' }),
  attribute('anc', 'Active noise cancellation', 'boolean', { filterable: true, group: 'Audio' }),
  attribute('microphone', 'Microphone', 'boolean', { group: 'Audio' }),
  attribute('water_resistance', 'Water resistance', 'text', { filterable: true, group: 'Durability' }),
];

const watchAttributes = [
  attribute('compatible_os', 'Compatible operating systems', 'multi_select', { options: ['Android', 'iOS'], required: true, filterable: true, group: 'Compatibility' }),
  measure('display_size', 'Display size', 'in', { filterable: true, group: 'Display' }),
  attribute('display_type', 'Display type', 'text', { group: 'Display' }),
  measure('battery_life', 'Battery life', 'days', { filterable: true, group: 'Battery' }),
  attribute('gps', 'Built-in GPS', 'boolean', { filterable: true, group: 'Connectivity' }),
  attribute('cellular', 'Cellular / eSIM', 'boolean', { filterable: true, group: 'Connectivity' }),
  attribute('health_features', 'Health and fitness features', 'textarea', { group: 'Health' }),
  attribute('water_resistance', 'Water resistance', 'text', { filterable: true, group: 'Durability' }),
  attribute('strap_size', 'Strap size', 'text', { variant: true, group: 'Variants' }),
];

const electronicsAttributes = [
  attribute('brand', 'Brand', 'text', { required: true, filterable: true, showOnCard: true, group: 'Identity' }),
  attribute('model_number', 'Model number', 'text', { required: true, group: 'Identity' }),
  attribute('manufacturer', 'Manufacturer', 'text', { group: 'Manufacturing' }),
  attribute('country_of_origin', 'Country of origin', 'text', { group: 'Manufacturing' }),
  attribute('warranty', 'Warranty', 'text', { required: true, filterable: true, group: 'Warranty' }),
  measure('power_consumption', 'Power consumption', 'W', { group: 'Power' }), measure('voltage', 'Voltage', 'V', { group: 'Power' }),
  attribute('connectivity', 'Connectivity', 'multi_select', { options: ['Bluetooth', 'Wi-Fi', 'USB', 'HDMI', 'NFC', 'Ethernet'], filterable: true, group: 'Connectivity' }),
  attribute('compatible_devices', 'Compatible devices', 'textarea', { group: 'Compatibility' }),
  attribute('included_components', 'Included components', 'textarea', { group: 'Package' }),
  attribute('dimensions', 'Dimensions', 'text', { group: 'Physical' }), measure('weight', 'Weight', 'kg', { group: 'Physical' }),
  attribute('colour', 'Colour', 'color', { filterable: true, variant: true, group: 'Variants' }),
];

const jewelleryAttributes = [
  choice('jewellery_type', 'Jewellery type', ['Necklace', 'Earrings', 'Ring', 'Bangle', 'Bracelet', 'Pendant', 'Chain'], { required: true, filterable: true, showOnCard: true }),
  choice('gender', 'Gender', ['Women', 'Men', 'Girls', 'Boys', 'Unisex'], { filterable: true }),
  choice('metal_type', 'Metal type', ['Gold', 'Silver', 'Platinum', 'Brass', 'Alloy'], { required: true, filterable: true }),
  choice('purity', 'Purity', ['14K', '18K', '22K', '24K', '925 Silver', 'Fashion jewellery'], { filterable: true }),
  attribute('gemstone', 'Gemstone', 'text', { filterable: true }), attribute('gemstone_type', 'Gemstone type'),
  measure('weight', 'Product weight', 'g', { required: true }), attribute('size', 'Size', 'text', { filterable: true, variant: true }),
  attribute('dimensions', 'Dimensions'), attribute('plating', 'Plating', 'text', { filterable: true }),
  choice('occasion', 'Occasion', ['Daily', 'Office', 'Festive', 'Wedding', 'Party'], { filterable: true }),
  attribute('certification', 'Certification'), choice('adjustability', 'Sizing', ['Adjustable', 'Fixed'], { filterable: true }),
  attribute('ring_size', 'Ring size', 'text', { variant: true }), measure('chain_length', 'Chain length', 'cm'),
  attribute('care_instructions', 'Care instructions', 'textarea'),
];

const cosmeticsAttributes = [
  attribute('brand', 'Brand', 'text', { required: true, filterable: true, showOnCard: true }),
  attribute('product_type', 'Product type', 'text', { required: true, filterable: true }),
  choice('skin_type', 'Skin type', ['All skin types', 'Normal', 'Dry', 'Oily', 'Combination', 'Sensitive'], { filterable: true }),
  choice('hair_type', 'Hair type', ['All hair types', 'Straight', 'Wavy', 'Curly', 'Coily', 'Treated'], { filterable: true }),
  attribute('concern', 'Concern', 'multi_select', { options: ['Acne', 'Dryness', 'Pigmentation', 'Ageing', 'Hair fall', 'Dandruff'], filterable: true }),
  attribute('shade', 'Shade', 'color', { filterable: true, variant: true, showOnCard: true }),
  choice('finish', 'Finish', ['Matte', 'Natural', 'Dewy', 'Glossy', 'Satin'], { filterable: true }),
  attribute('ingredients', 'Ingredients', 'textarea', { required: true }), attribute('key_ingredients', 'Key ingredients', 'multi_select'),
  measure('quantity', 'Net quantity', 'ml', { variant: true, required: true }),
  choice('formulation', 'Formulation', ['Liquid', 'Cream', 'Gel', 'Powder', 'Oil', 'Solid'], { filterable: true }),
  attribute('fragrance', 'Fragrance'), attribute('benefits', 'Benefits', 'textarea'), attribute('how_to_use', 'How to use', 'textarea'),
  attribute('shelf_life', 'Shelf life', 'text', { required: true }), attribute('manufacturing_info', 'Manufacturing information', 'textarea'),
  attribute('warnings', 'Warnings', 'textarea'),
];

const artAttributes = [
  choice('art_type', 'Art type', ['Painting', 'Print', 'Sculpture', 'Photography', 'Wall art'], { required: true, filterable: true }),
  attribute('artist', 'Artist', 'text', { required: true, filterable: true, showOnCard: true }), attribute('art_style', 'Art style', 'text', { filterable: true }),
  attribute('medium', 'Medium', 'text', { required: true, filterable: true }), attribute('material', 'Material', 'text', { filterable: true }),
  choice('orientation', 'Orientation', ['Portrait', 'Landscape', 'Square', 'Panoramic'], { filterable: true }),
  measure('width', 'Width', 'cm', { required: true }), measure('height', 'Height', 'cm', { required: true }), measure('depth', 'Depth', 'cm'),
  choice('framing', 'Framing', ['Framed', 'Unframed'], { filterable: true, variant: true }), attribute('frame_material', 'Frame material'),
  attribute('dominant_colours', 'Dominant colours', 'multi_select', { filterable: true }), attribute('theme', 'Theme', 'text', { filterable: true }),
  choice('production', 'Production', ['Handmade', 'Printed'], { filterable: true }), choice('authenticity', 'Authenticity', ['Original', 'Limited edition', 'Reproduction'], { filterable: true }),
  attribute('year', 'Year', 'number', { validation: { min: 1000, max: 2200 } }), attribute('edition', 'Edition'),
  attribute('suitable_room', 'Suitable room', 'multi_select', { options: ['Living room', 'Bedroom', 'Office', 'Lobby', 'Dining room'], filterable: true }),
];

const bakeryAttributes = [
  attribute('product_type', 'Product type', 'text', { required: true, filterable: true, showOnCard: true }),
  choice('flavour', 'Flavour', ['Chocolate', 'Vanilla', 'Butterscotch', 'Red Velvet', 'Fruit', 'Custom'], { required: true, filterable: true, variant: true }),
  measure('weight', 'Weight', 'g', { required: true, filterable: true, variant: true }), attribute('quantity', 'Quantity / pieces', 'number', { validation: { min: 1 } }),
  attribute('ingredients', 'Ingredients', 'textarea', { required: true }),
  attribute('allergens', 'Allergens', 'multi_select', { options: ['Gluten', 'Milk', 'Nuts', 'Soy', 'Egg'], filterable: true }),
  choice('food_type', 'Food preference', ['Vegetarian', 'Non vegetarian', 'Vegan'], { required: true, filterable: true }),
  attribute('eggless', 'Eggless', 'boolean', { filterable: true }), measure('preparation_time', 'Preparation time', 'hours', { required: true }),
  measure('shelf_life', 'Shelf life', 'days', { required: true }), attribute('storage_instructions', 'Storage instructions', 'textarea', { required: true }),
  attribute('batch_number', 'Batch number', 'text', { required: true }), attribute('manufacturing_date', 'Manufacturing date', 'date'), attribute('expiry_date', 'Expiry / best before', 'date', { required: true }),
  attribute('nutrition_information', 'Nutrition information', 'textarea'), attribute('serving_size', 'Serving size'),
  attribute('customization_message', 'Customization options', 'textarea'), attribute('delivery_availability', 'Delivery availability', 'textarea'),
];

const footwearAttributes = [
  choice('gender', 'Gender', ['Women', 'Men', 'Girls', 'Boys', 'Unisex'], { required: true, filterable: true }),
  attribute('footwear_type', 'Footwear type', 'text', { required: true, filterable: true, showOnCard: true }),
  attribute('size', 'Size', 'multi_select', { required: true, filterable: true, variant: true }), attribute('colour', 'Colour', 'color', { filterable: true, variant: true }),
  attribute('upper_material', 'Upper material', 'text', { required: true, filterable: true }), attribute('sole_material', 'Sole material', 'text', { filterable: true }),
  choice('closure_type', 'Closure type', ['Lace-up', 'Slip-on', 'Buckle', 'Zip', 'Hook & loop'], { filterable: true }), measure('heel_height', 'Heel height', 'cm'),
  choice('heel_type', 'Heel type', ['Flat', 'Block', 'Stiletto', 'Wedge', 'Platform'], { filterable: true }),
  choice('occasion', 'Occasion', ['Casual', 'Formal', 'Sports', 'Party', 'Outdoor'], { filterable: true }),
  attribute('pattern', 'Pattern', 'text', { filterable: true }), choice('fit', 'Fit', ['Narrow', 'Regular', 'Wide'], { filterable: true }),
  attribute('cushioning', 'Cushioning'), attribute('waterproof', 'Waterproof', 'boolean', { filterable: true }),
  attribute('care_instructions', 'Care instructions', 'textarea'),
];

const homeAttributes = [
  attribute('product_type', 'Product type', 'text', { required: true, filterable: true, showOnCard: true }),
  attribute('material', 'Material', 'text', { required: true, filterable: true }), attribute('dimensions', 'Dimensions'),
  measure('length', 'Length', 'cm'), measure('width', 'Width', 'cm'), measure('height', 'Height', 'cm'), measure('weight', 'Weight', 'kg'),
  attribute('colour', 'Colour', 'color', { filterable: true, variant: true }),
  attribute('room_type', 'Room type', 'multi_select', { options: ['Living room', 'Bedroom', 'Kitchen', 'Bathroom', 'Office', 'Outdoor'], filterable: true }),
  choice('style', 'Style', ['Modern', 'Traditional', 'Minimal', 'Rustic', 'Bohemian', 'Industrial'], { filterable: true }),
  attribute('assembly_required', 'Assembly required', 'boolean', { filterable: true }), attribute('care_instructions', 'Care instructions', 'textarea'),
  attribute('package_contents', 'Package contents', 'textarea'), attribute('finish', 'Finish', 'text', { filterable: true }), attribute('shape', 'Shape', 'text', { filterable: true }),
];

const namesToCategories = (names, variants = []) => names.map((name) => category(key(name), name, '', { variantAttributes: variants }));
const withSubcategories = (definitions, groups = {}) => [
  ...definitions,
  ...Object.entries(groups).flatMap(([parentKey, names]) => (names || []).map((name) => category(`${parentKey}_${key(name)}`, name, parentKey))),
];

const electronicsCategories = [
  category('mobiles', 'Mobiles', '', { attributes: [...mobileAttributes, ...smartphoneAttributes], variantAttributes: ['ram', 'storage', 'colour'] }),
  category('laptops', 'Laptops', '', { attributes: [attribute('processor', 'Processor', 'text', { required: true }), choice('ram', 'RAM', ['4', '8', '16', '32', '64'], { unit: 'GB', variant: true, filterable: true }), choice('ssd', 'SSD storage', ['128', '256', '512', '1024', '2048'], { unit: 'GB', variant: true, filterable: true }), attribute('gpu', 'Graphics processor'), measure('screen_size', 'Screen size', 'in'), attribute('operating_system', 'Operating system')], variantAttributes: ['ram', 'ssd', 'colour'] }),
  category('televisions', 'Televisions', '', { attributes: [measure('screen_size', 'Screen size', 'in', { variant: true, filterable: true }), choice('resolution', 'Resolution', ['HD', 'Full HD', '4K', '8K'], { filterable: true }), attribute('panel_type', 'Panel type'), measure('refresh_rate', 'Refresh rate', 'Hz'), attribute('smart_tv_platform', 'Smart TV platform')], variantAttributes: ['screen_size', 'colour'] }),
  category('headphones', 'Headphones', '', { attributes: [attribute('connectivity', 'Connectivity'), measure('driver_size', 'Driver size', 'mm'), measure('battery_life', 'Battery life', 'hours'), attribute('anc', 'Active noise cancellation', 'boolean', { filterable: true }), attribute('microphone', 'Microphone', 'boolean')], variantAttributes: ['colour'] }),
  category('smart_watches', 'Smart Watches', '', { attributes: [attribute('compatible_os', 'Compatible OS'), measure('display_size', 'Display size', 'in'), measure('battery_life', 'Battery life', 'days'), attribute('gps', 'GPS', 'boolean'), attribute('water_resistance', 'Water resistance')], variantAttributes: ['colour'] }),
  category('appliances', 'Appliances'), category('cameras', 'Cameras'), category('accessories', 'Accessories'),
];

const mobileCategoryDefinitions = withSubcategories([
  category('smartphones', 'Smartphones', '', {
    attributes: smartphoneAttributes,
    variantAttributes: ['ram', 'storage', 'colour'],
    filters: ['brand', 'condition', 'ram', 'storage', 'processor', 'display_size', 'network_type', 'charging_power', 'ip_rating', 'colour'],
  }),
  category('feature_phones', 'Feature Phones', '', {
    attributes: featurePhoneAttributes,
    variantAttributes: ['storage', 'colour'],
    filters: ['brand', 'condition', 'storage', 'network_type', 'display_size', 'colour'],
  }),
  category('cases_covers', 'Cases & Covers', '', {
    attributes: caseAttributes,
    variantAttributes: ['colour'],
    filters: ['brand', 'case_type', 'material', 'wireless_charging_compatible', 'colour'],
  }),
  category('chargers', 'Chargers', '', {
    attributes: chargerAttributes,
    variantAttributes: ['connector_type', 'colour'],
    filters: ['brand', 'charger_type', 'output_power', 'connector_type', 'charging_protocols', 'colour'],
  }),
  category('earphones', 'Earphones', '', {
    attributes: earphoneAttributes,
    variantAttributes: ['colour'],
    filters: ['brand', 'earphone_type', 'connectivity', 'battery_life', 'anc', 'water_resistance', 'colour'],
  }),
  category('smart_watches', 'Smart Watches', '', {
    attributes: watchAttributes,
    variantAttributes: ['colour', 'strap_size'],
    filters: ['brand', 'compatible_os', 'display_size', 'battery_life', 'gps', 'cellular', 'water_resistance', 'colour'],
  }),
], {
  smartphones: ['Android Phones', 'iPhones', '5G Phones', 'Budget Phones', 'Gaming Phones', 'Foldable Phones'],
  feature_phones: ['Keypad Phones', '4G Feature Phones', 'Senior Phones'],
  cases_covers: ['Back Covers', 'Flip Covers', 'Screen Protectors', 'Camera Protectors'],
  chargers: ['Fast Chargers', 'Wireless Chargers', 'Power Banks', 'Charging Cables', 'Car Chargers'],
  earphones: ['Wireless Earbuds', 'Neckbands', 'Wired Earphones', 'Headphones'],
  smart_watches: ['Fitness Watches', 'Calling Watches', 'Kids Watches'],
});

const INDUSTRY_PRESETS = [
  preset({ id: 'fashion', name: 'Fashion & Clothing', sizing: true, attributes: fashionAttributes, categories: ['Sarees', 'Kurtas & Sets', 'Dresses', 'Tops', 'Bottomwear', 'Accessories'], categoryDefinitions: withSubcategories([category('sarees', 'Sarees', '', { variantAttributes: ['colour'] }), ...namesToCategories(['Kurtas & Sets', 'Dresses', 'Tops', 'Bottomwear'], ['size', 'colour']), category('accessories', 'Accessories')], { sarees: ['Silk Sarees', 'Cotton Sarees', 'Designer Sarees', 'Wedding Sarees'], kurtas_sets: ['Kurta Sets', 'Anarkali Sets', 'Sharara Sets'], dresses: ['Maxi Dresses', 'Midi Dresses', 'Party Dresses'], tops: ['Ethnic Tops', 'Casual Tops'], bottomwear: ['Palazzos', 'Trousers', 'Skirts'], accessories: ['Dupattas', 'Handbags', 'Fashion Jewellery'] }), filters: ['category', 'price', 'size', 'colour', 'material', 'fit', 'occasion', 'availability'], sections: ['hero', 'categories', 'newArrivals', 'trending', 'bestSellers', 'offers'], variants: ['size', 'colour'], productSections: ['overview', 'size-guide', 'material-care', 'specifications', 'delivery', 'returns', 'reviews'] }),
  preset({ id: 'mobile', name: 'Mobile Store', attributes: mobileAttributes, categories: ['Smartphones', 'Feature Phones', 'Cases & Covers', 'Chargers', 'Earphones', 'Smart Watches'], categoryDefinitions: mobileCategoryDefinitions, filters: ['category', 'price', 'brand', 'condition', 'colour', 'ram', 'storage', 'processor', 'network_type', 'warranty_type', 'availability'], sections: ['hero', 'categories', 'newArrivals', 'bestSellers', 'featured', 'offers'], variants: ['colour'], features: { comparison: true, technical: true }, returns: { mode: 'replacement', defaultWindowDays: 7 }, productSections: ['overview', 'highlights', 'technical-specifications', 'compatibility', 'box-contents', 'warranty', 'delivery', 'replacement', 'reviews'] }),
  preset({ id: 'electronics', name: 'Electronics', attributes: electronicsAttributes, categories: ['Mobiles', 'Laptops', 'Televisions', 'Headphones', 'Smart Watches', 'Appliances', 'Cameras', 'Accessories'], categoryDefinitions: withSubcategories(electronicsCategories, { mobiles: ['Android Phones', 'iPhones'], laptops: ['Gaming Laptops', 'Business Laptops', 'Ultrabooks'], televisions: ['Smart TVs', 'OLED TVs'], headphones: ['Wireless Headphones', 'True Wireless Earbuds'], appliances: ['Kitchen Appliances', 'Home Appliances'], cameras: ['Mirrorless Cameras', 'Action Cameras'] }), filters: ['category', 'price', 'brand', 'connectivity', 'warranty', 'colour', 'rating', 'availability'], sections: ['hero', 'categories', 'featured', 'bestSellers', 'offers'], variants: ['colour'], features: { comparison: true, technical: true }, returns: { mode: 'replacement', defaultWindowDays: 7 }, productSections: ['overview', 'technical-specifications', 'compatibility', 'box-contents', 'warranty', 'delivery', 'replacement', 'reviews'] }),
  preset({ id: 'jewellery', name: 'Jewellery', attributes: jewelleryAttributes, categories: ['Necklaces', 'Earrings', 'Rings', 'Bangles', 'Bridal Jewellery', 'Silver Jewellery'], categoryDefinitions: withSubcategories(namesToCategories(['Necklaces', 'Earrings', 'Rings', 'Bangles', 'Bridal Jewellery', 'Silver Jewellery']), { necklaces: ['Chokers', 'Pendant Sets', 'Long Necklaces'], earrings: ['Studs', 'Jhumkas', 'Hoops'], rings: ['Adjustable Rings', 'Couple Rings'], bangles: ['Bangle Sets', 'Bracelets'], bridal_jewellery: ['Bridal Sets', 'Maang Tikka'] }), filters: ['category', 'price', 'jewellery_type', 'metal_type', 'purity', 'gemstone', 'occasion', 'availability'], sections: ['hero', 'categories', 'newArrivals', 'wedding', 'bestSellers', 'offers'], variants: ['size', 'ring_size'], productSections: ['overview', 'metal-gemstone', 'certification', 'dimensions', 'care', 'delivery', 'returns', 'reviews'] }),
  preset({ id: 'cosmetics', name: 'Beauty & Cosmetics', attributes: cosmeticsAttributes, categories: ['Makeup', 'Skin Care', 'Hair Care', 'Fragrance', 'Bath & Body', 'Beauty Tools'], categoryDefinitions: withSubcategories(namesToCategories(['Makeup', 'Skin Care', 'Hair Care', 'Fragrance', 'Bath & Body', 'Beauty Tools']), { makeup: ['Face Makeup', 'Eye Makeup', 'Lip Makeup', 'Nail Care'], skin_care: ['Cleansers', 'Moisturisers', 'Serums', 'Sunscreen'], hair_care: ['Shampoo', 'Conditioner', 'Hair Treatments'], fragrance: ['Perfume', 'Body Mist'] }), filters: ['category', 'price', 'brand', 'skin_type', 'concern', 'shade', 'finish', 'rating'], sections: ['hero', 'categories', 'newArrivals', 'trending', 'bestSellers', 'offers'], variants: ['shade', 'quantity'], productSections: ['overview', 'benefits', 'ingredients', 'how-to-use', 'warnings', 'manufacturing', 'delivery', 'returns', 'reviews'] }),
  preset({ id: 'art', name: 'Art & Paintings', attributes: artAttributes, categories: ['Paintings', 'Prints', 'Sculptures', 'Wall Art', 'Photography', 'Handmade Art'], categoryDefinitions: withSubcategories(namesToCategories(['Paintings', 'Prints', 'Sculptures', 'Wall Art', 'Photography', 'Handmade Art']), { paintings: ['Abstract Paintings', 'Landscape Paintings', 'Portraits'], prints: ['Art Prints', 'Limited Editions'], sculptures: ['Table Sculptures', 'Floor Sculptures'], wall_art: ['Canvas Art', 'Metal Wall Art'], photography: ['Nature Photography', 'Fine Art Photography'] }), filters: ['category', 'price', 'artist', 'art_style', 'medium', 'orientation', 'framing', 'availability'], sections: ['hero', 'categories', 'featured', 'newArrivals', 'artistSpotlight'], variants: ['framing'], productSections: ['overview', 'artist', 'art-details', 'dimensions', 'authenticity', 'delivery', 'returns'] }),
  preset({ id: 'bakery', name: 'Bakery & Food', attributes: bakeryAttributes, categories: ['Cakes', 'Pastries', 'Cookies', 'Breads', 'Gift Hampers', 'Custom Orders'], categoryDefinitions: withSubcategories(namesToCategories(['Cakes', 'Pastries', 'Cookies', 'Breads', 'Gift Hampers', 'Custom Orders']), { cakes: ['Birthday Cakes', 'Wedding Cakes', 'Photo Cakes', 'Cupcakes'], pastries: ['Cream Pastries', 'Tea Cakes'], cookies: ['Butter Cookies', 'Chocolate Cookies'], breads: ['Fresh Breads', 'Buns'], gift_hampers: ['Festival Hampers', 'Corporate Hampers'] }), filters: ['category', 'price', 'flavour', 'weight', 'food_type', 'eggless', 'delivery_availability'], sections: ['hero', 'categories', 'todaySpecial', 'bestSellers', 'customOrders', 'offers'], variants: ['weight', 'flavour'], features: { perishable: true, customization: true }, inventory: { mode: 'batch', trackExpiry: true, lowStockDefault: 3 }, delivery: { supportsScheduledDelivery: true, supportsLocalOnly: true }, returns: { mode: 'non-returnable', defaultWindowDays: 0, nonReturnableWhenCustomized: true }, productSections: ['overview', 'ingredients', 'allergens', 'nutrition', 'customization', 'storage', 'delivery'] }),
  preset({ id: 'footwear', name: 'Shoes & Footwear', sizing: true, attributes: footwearAttributes, categories: ['Women', 'Men', 'Kids', 'Sports Shoes', 'Sandals', 'Formal Shoes'], categoryDefinitions: withSubcategories(namesToCategories(['Women', 'Men', 'Kids', 'Sports Shoes', 'Sandals', 'Formal Shoes'], ['size', 'colour']), { women: ['Heels', 'Flats', 'Women Sneakers'], men: ['Men Sneakers', 'Loafers', 'Boots'], kids: ['Girls Footwear', 'Boys Footwear'], sports_shoes: ['Running Shoes', 'Training Shoes'], sandals: ['Casual Sandals', 'Ethnic Sandals'] }), filters: ['category', 'price', 'gender', 'size', 'colour', 'upper_material', 'occasion', 'fit', 'availability'], sections: ['hero', 'categories', 'newArrivals', 'trending', 'bestSellers', 'offers'], variants: ['size', 'colour'], productSections: ['overview', 'size-guide', 'materials', 'fit-comfort', 'care', 'delivery', 'returns', 'reviews'] }),
  preset({ id: 'home', name: 'Home & Decor', attributes: homeAttributes, categories: ['Decor', 'Furnishing', 'Kitchen', 'Lighting', 'Storage', 'Gifting'], categoryDefinitions: withSubcategories(namesToCategories(['Decor', 'Furnishing', 'Kitchen', 'Lighting', 'Storage', 'Gifting']), { decor: ['Wall Decor', 'Vases', 'Clocks'], furnishing: ['Bedsheets', 'Cushions', 'Curtains'], kitchen: ['Cookware', 'Dining', 'Kitchen Storage'], lighting: ['Lamps', 'Ceiling Lights'], storage: ['Organisers', 'Shelves'], gifting: ['Gift Sets', 'Personalised Gifts'] }), filters: ['category', 'price', 'product_type', 'material', 'colour', 'room_type', 'style', 'availability'], sections: ['hero', 'categories', 'featured', 'newArrivals', 'bestSellers', 'offers'], variants: ['colour'], productSections: ['overview', 'dimensions', 'material-finish', 'assembly-care', 'package-contents', 'delivery', 'returns', 'reviews'] }),
];

// Append optional workflows: the legacy fashion/default preset remains first.
INDUSTRY_PRESETS.push(preset({ id: 'boutique', name: 'Boutique — Sale & Rental', sizing: true, commerce: { mode: 'SALE_AND_RENTAL' }, attributes: [...fashionAttributes, choice('accessory_size', 'Bangle / ring size', ['2.2', '2.4', '2.6', '2.8', 'Adjustable', 'Free Size'], { filterable: true, group: 'Accessories' }), attribute('set_contents', 'Set components', 'textarea', { group: 'Rental set' })], categories: ['Lehengas', 'Sarees', 'Bridal Sets', 'Bangles', 'Necklaces', 'Accessories'], categoryDefinitions: namesToCategories(['Lehengas', 'Sarees', 'Bridal Sets', 'Bangles', 'Necklaces', 'Accessories'], ['size', 'colour']), filters: ['category', 'price', 'size', 'colour', 'occasion', 'availability'], sections: ['hero', 'categories', 'wedding', 'newArrivals', 'bestSellers'], variants: ['size', 'colour'], productSections: ['overview', 'size-guide', 'material-care', 'specifications', 'delivery', 'returns', 'reviews'] }));

function key(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
function title(value) { return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }

const INDUSTRY_IDS = INDUSTRY_PRESETS.map((item) => item.id);
const DEFAULT_STRUCTURE = { ...{"id":"boutique","name":"Boutique — Sale & Rental","industry":"boutique","version":2,"active":true,"commerce":{"mode":"SALE_AND_RENTAL","rentalModuleVersion":1,"stockMode":"SEPARATE_RENTAL_ASSETS"},"features":{"sizing":true,"specifications":true,"comparison":false,"perishable":false,"customization":false,"technical":false},"attributes":[{"key":"gender","label":"Gender","type":"dropdown","unit":"","required":false,"filterable":true,"searchable":true,"showOnCard":true,"showOnDetail":true,"showInSpecifications":true,"variant":false,"options":["Women","Men","Girls","Boys","Unisex"],"defaultValue":"","sortOrder":1,"group":"Style","validation":{}},{"key":"clothing_type","label":"Clothing type","type":"dropdown","unit":"","required":false,"filterable":true,"searchable":true,"showOnCard":false,"showOnDetail":true,"showInSpecifications":true,"variant":false,"options":["Saree","Kurta Set","Dress","Top","Bottomwear","Co-ord Set","Lehenga","Accessory"],"defaultValue":"","sortOrder":2,"group":"Style","validation":{}},{"key":"size","label":"Size","type":"dropdown","unit":"","required":false,"filterable":true,"searchable":true,"showOnCard":false,"showOnDetail":true,"showInSpecifications":true,"variant":true,"options":["XS","S","M","L","XL","XXL","3XL","Free Size"],"defaultValue":"","sortOrder":3,"group":"Variants","validation":{}},{"key":"colour","label":"Colour","type":"color","unit":"","required":false,"filterable":true,"searchable":true,"showOnCard":true,"showOnDetail":true,"showInSpecifications":true,"variant":true,"options":[],"defaultValue":"","sortOrder":4,"group":"Variants","validation":{}},{"key":"material","label":"Material","type":"dropdown","unit":"","required":false,"filterable":true,"searchable":true,"showOnCard":false,"showOnDetail":true,"showInSpecifications":true,"variant":false,"options":["Cotton","Silk","Georgette","Rayon","Linen","Denim","Velvet","Net","Synthetic"],"defaultValue":"","sortOrder":5,"group":"Material & care","validation":{}},{"key":"fit","label":"Fit","type":"dropdown","unit":"","required":false,"filterable":true,"searchable":true,"showOnCard":false,"showOnDetail":true,"showInSpecifications":true,"variant":false,"options":["Regular","Slim","Relaxed","Oversized","Tailored"],"defaultValue":"","sortOrder":6,"group":"Style","validation":{}},{"key":"pattern","label":"Pattern","type":"dropdown","unit":"","required":false,"filterable":true,"searchable":true,"showOnCard":false,"showOnDetail":true,"showInSpecifications":true,"variant":false,"options":["Solid","Printed","Embroidered","Striped","Checked","Woven"],"defaultValue":"","sortOrder":7,"group":"Style","validation":{}},{"key":"sleeve_type","label":"Sleeve type","type":"dropdown","unit":"","required":false,"filterable":false,"searchable":true,"showOnCard":false,"showOnDetail":true,"showInSpecifications":true,"variant":false,"options":["Sleeveless","Short","Half","Three-quarter","Long"],"defaultValue":"","sortOrder":8,"group":"Style","validation":{}},{"key":"neckline","label":"Neckline","type":"dropdown","unit":"","required":false,"filterable":false,"searchable":true,"showOnCard":false,"showOnDetail":true,"showInSpecifications":true,"variant":false,"options":["Round","V-Neck","Square","Boat","Collared","Sweetheart"],"defaultValue":"","sortOrder":9,"group":"Style","validation":{}},{"key":"occasion","label":"Occasion","type":"dropdown","unit":"","required":false,"filterable":true,"searchable":true,"showOnCard":false,"showOnDetail":true,"showInSpecifications":true,"variant":false,"options":["Casual","Work","Festive","Wedding","Party","Sports"],"defaultValue":"","sortOrder":10,"group":"Style","validation":{}},{"key":"fabric","label":"Fabric","type":"text","unit":"","required":false,"filterable":true,"searchable":true,"showOnCard":false,"showOnDetail":true,"showInSpecifications":true,"variant":false,"options":[],"defaultValue":"","sortOrder":11,"group":"Material & care","validation":{}},{"key":"wash_care","label":"Wash care","type":"textarea","unit":"","required":false,"filterable":false,"searchable":true,"showOnCard":false,"showOnDetail":true,"showInSpecifications":true,"variant":false,"options":[],"defaultValue":"","sortOrder":12,"group":"Material & care","validation":{}},{"key":"country_of_origin","label":"Country of origin","type":"text","unit":"","required":false,"filterable":false,"searchable":true,"showOnCard":false,"showOnDetail":true,"showInSpecifications":true,"variant":false,"options":[],"defaultValue":"","sortOrder":13,"group":"Manufacturing","validation":{}},{"key":"accessory_size","label":"Bangle / ring size","type":"dropdown","unit":"","required":false,"filterable":true,"searchable":true,"showOnCard":false,"showOnDetail":true,"showInSpecifications":true,"variant":false,"options":["2.2","2.4","2.6","2.8","Adjustable","Free Size"],"defaultValue":"","sortOrder":14,"group":"Accessories","validation":{}},{"key":"set_contents","label":"Set components","type":"textarea","unit":"","required":false,"filterable":false,"searchable":true,"showOnCard":false,"showOnDetail":true,"showInSpecifications":true,"variant":false,"options":[],"defaultValue":"","sortOrder":15,"group":"Rental set","validation":{}}],"defaultCategories":["Lehengas","Sarees","Bridal Sets","Bangles","Necklaces","Accessories"],"categoryDefinitions":[{"key":"lehengas","name":"Lehengas","parentKey":"","active":true,"attributes":[],"variantAttributes":["size","colour"],"filters":[]},{"key":"sarees","name":"Sarees","parentKey":"","active":true,"attributes":[],"variantAttributes":["size","colour"],"filters":[]},{"key":"bridal_sets","name":"Bridal Sets","parentKey":"","active":true,"attributes":[],"variantAttributes":["size","colour"],"filters":[]},{"key":"bangles","name":"Bangles","parentKey":"","active":true,"attributes":[],"variantAttributes":["size","colour"],"filters":[]},{"key":"necklaces","name":"Necklaces","parentKey":"","active":true,"attributes":[],"variantAttributes":["size","colour"],"filters":[]},{"key":"accessories","name":"Accessories","parentKey":"","active":true,"attributes":[],"variantAttributes":["size","colour"],"filters":[]}],"filters":[{"key":"category","label":"Category","type":"value","enabled":true},{"key":"price","label":"Price","type":"value","enabled":true},{"key":"size","label":"Size","type":"value","enabled":true},{"key":"colour","label":"Colour","type":"value","enabled":true},{"key":"occasion","label":"Occasion","type":"value","enabled":true},{"key":"availability","label":"Availability","type":"value","enabled":true}],"sortingOptions":[{"key":"newest","label":"Newest first"},{"key":"bestSeller","label":"Popularity"},{"key":"priceLowHigh","label":"Price: low to high"},{"key":"priceHighLow","label":"Price: high to low"},{"key":"discount","label":"Best discount"},{"key":"rating","label":"Customer rating"}],"measurementUnits":["piece","g","kg","ml","l","cm","in"],"variantConfig":{"enabled":true,"attributes":["size","colour"],"autoGenerate":false,"maxCombinations":120,"skuPattern":"{base}-{options}"},"productSections":["overview","size-guide","material-care","specifications","delivery","returns","reviews"],"productCard":{"fields":["name","price","discountPercentage"],"attributeKeys":["gender","colour"]},"inventory":{"mode":"variant","trackExpiry":false,"allowBackorder":false,"lowStockDefault":5},"delivery":{"requiresWeight":true,"supportsScheduledDelivery":false,"supportsLocalOnly":false},"returns":{"mode":"return","defaultWindowDays":7,"nonReturnableWhenCustomized":false},"seo":{"titlePattern":"{product} | {store}","descriptionAttributes":["gender","clothing_type","size","colour","material"]},"homepageSections":["hero","categories","wedding","newArrivals","bestSellers"],"recommendationGroups":["same-category","similar-price","recently-viewed"],"badges":["new","best-seller","featured","low-stock"]}, clientPermissions: { content: true, payments: true } };
const getIndustryPreset = (industry = 'fashion') => INDUSTRY_PRESETS.find((item) => item.id === industry) || INDUSTRY_PRESETS[0];

module.exports = { ATTRIBUTE_TYPES, INDUSTRY_IDS, INDUSTRY_PRESETS, DEFAULT_STRUCTURE, attribute, getIndustryPreset };
