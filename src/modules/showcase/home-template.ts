export const HOME_CANVAS = { width: 851, height: 1847 } as const;

export interface HomeShowcaseInput {
  businessName: string;
  website: string;
  logo: string;
  heroImage: string;
  announcementImage: string;
  featureImages: [string, string, string];
  brandAccent: string;
  logoSurface: "light" | "dark";
  eyebrow: string;
  headline: [string, string];
  description: [string, string];
  cta: string;
  categories: [string, string, string, string, string];
  announcementEyebrow: string;
  announcementHeadline: [string, string];
  announcementDetail: string;
  featuresTitle: string;
  features: [
    { title: string; subtitle: string },
    { title: string; subtitle: string },
    { title: string; subtitle: string },
  ];
}

export interface HomeShowcaseImages {
  logo: string;
  hero: string;
  announcement: string;
  features: [string, string, string];
}

const svg = (body: string, size = 38): string => `<svg width="${size}" height="${size}" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const icons = {
  search: svg('<circle cx="17" cy="17" r="10"/><path d="M25 25l9 9"/>', 34),
  bell: svg('<path d="M11 29h18l-3-4V17c0-5-2-8-6-8s-6 3-6 8v8z"/><path d="M17 32c1 3 5 3 6 0"/>', 34),
  arrow: svg('<path d="M5 20h28M24 11l9 9-9 9"/>', 34),
  home: svg('<path d="M5 18L20 6l15 12"/><path d="M9 17v17h9V23h5v11h8V17"/>'),
  calendar: svg('<rect x="7" y="10" width="26" height="24" rx="2"/><path d="M13 6v8M27 6v8M7 18h26M14 24h2M23 24h2M14 29h2M23 29h2"/>'),
  community: svg('<circle cx="20" cy="13" r="5"/><circle cx="8" cy="17" r="3"/><circle cx="32" cy="17" r="3"/><path d="M10 34v-5c0-5 4-8 10-8s10 3 10 8v5zM3 34v-6c0-3 2-5 5-5M37 34v-6c0-3-2-5-5-5"/>'),
  account: svg('<circle cx="20" cy="12" r="6"/><path d="M8 34c1-8 5-12 12-12s11 4 12 12z"/>'),
  category: [
    svg('<path d="M7 31l19-19M25 8l7 7M4 34l5-1-4-4zM28 6l6 6M21 16l5 5"/>', 45),
    svg('<path d="M20 2v9M20 29v9M2 20h9M29 20h9M7 7l6 6M27 27l6 6M33 7l-6 6M13 27l-6 6"/><circle cx="20" cy="20" r="4"/>', 45),
    svg('<circle cx="20" cy="20" r="13"/><path d="M11 21c5-2 7-4 9-8 3 5 5 6 9 8M14 26c4 3 8 3 12 0"/>', 45),
    svg('<path d="M10 32c4-7 4-17 4-23M30 32c-4-7-4-17-4-23M14 17c4 3 8 3 12 0M8 34h24"/>', 45),
    svg('<path d="M20 34C8 28 7 19 12 10c4 3 7 7 8 13 1-6 4-10 8-13 5 9 4 18-8 24zM9 21c-4-2-6-5-6-5 0 9 4 15 17 18M31 21c4-2 6-5 6-5 0 9-4 15-17 18"/>', 45),
  ],
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

function text(value: string, max: number, field: string): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max || /[\r\n\t]/.test(cleaned)) {
    throw new Error(`${field} must contain 1–${max} printable characters on one line`);
  }
  return cleaned;
}

export function validateHomeShowcase(input: HomeShowcaseInput): HomeShowcaseInput {
  text(input.businessName, 48, "businessName");
  const website = new URL(input.website);
  if (!["http:", "https:"].includes(website.protocol)) throw new Error("website must be an HTTP(S) URL");
  if (!/^#[0-9a-fA-F]{6}$/.test(input.brandAccent)) throw new Error("brandAccent must be a six-digit hex color");
  if (!["light", "dark"].includes(input.logoSurface)) throw new Error("logoSurface must be light or dark");
  text(input.eyebrow, 32, "eyebrow");
  input.headline.forEach((v, i) => text(v, 19, `headline[${i}]`));
  input.description.forEach((v, i) => text(v, 35, `description[${i}]`));
  text(input.cta, 26, "cta");
  input.categories.forEach((v, i) => text(v, 13, `categories[${i}]`));
  text(input.announcementEyebrow, 28, "announcementEyebrow");
  input.announcementHeadline.forEach((v, i) => text(v, 20, `announcementHeadline[${i}]`));
  text(input.announcementDetail, 32, "announcementDetail");
  text(input.featuresTitle, 28, "featuresTitle");
  input.features.forEach((feature, i) => {
    text(feature.title, 19, `features[${i}].title`);
    text(feature.subtitle, 31, `features[${i}].subtitle`);
  });
  return input;
}

export function renderHomeHtml(input: HomeShowcaseInput, images: HomeShowcaseImages): string {
  validateHomeShowcase(input);
  const e = escapeHtml;
  const categories = input.categories.map((label, index) => `<div class="category"><div class="category-icon">${icons.category[index]}</div><span>${e(label)}</span></div>`).join("");
  const features = input.features.map((feature, index) => `<div class="feature"><img src="${images.features[index]}" alt=""/><div class="feature-shade"></div><div class="feature-copy"><strong>${e(feature.title)}</strong><span>${e(feature.subtitle)}</span></div></div>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=${HOME_CANVAS.width}, initial-scale=1"/><title>${e(input.businessName)} — Home concept</title><style>
*{box-sizing:border-box}html,body{margin:0;width:${HOME_CANVAS.width}px;height:${HOME_CANVAS.height}px;overflow:hidden}body{font-family:Arial,Helvetica,sans-serif;color:#171512;-webkit-font-smoothing:antialiased}.canvas{position:relative;width:${HOME_CANVAS.width}px;height:${HOME_CANVAS.height}px;overflow:hidden;background:radial-gradient(circle at 85% 30%,#d7c6b2,#a9a397 61%,#bcb0a0)}.phone{position:absolute;left:10px;top:8px;width:831px;height:1793px;border-radius:100px;background:linear-gradient(105deg,#050505 0%,#555 4%,#070707 10%,#111 88%,#686868 95%,#020202 100%);box-shadow:0 20px 30px #16110c66, inset 0 0 0 3px #070707, inset 0 0 0 10px #4d4d4d}.phone:after{content:"";position:absolute;inset:9px;border:5px solid #0a0a0a;border-radius:94px;pointer-events:none;z-index:20}.screen{position:absolute;left:29px;top:27px;width:773px;height:1739px;border-radius:77px;overflow:hidden;background:linear-gradient(180deg,#f5f0e9 0%,#faf7f3 50%,#f6f1ed 100%)}
.hero-photo{position:absolute;left:172px;top:177px;width:690px;height:680px;object-fit:contain;object-position:center bottom;filter:saturate(.91)}.hero-wash{position:absolute;inset:0 0 auto 0;height:895px;background:linear-gradient(90deg,#f5eee8 0%,#f5eee8e8 30%,#f5eee82b 53%,transparent 77%),linear-gradient(180deg,#e8ded2 0%,transparent 24%,transparent 75%,#f8f5f1 100%)}.hero-shadow{position:absolute;right:0;top:90px;width:520px;height:550px;background:radial-gradient(ellipse at 80% 15%,#88745e36,transparent 60%);filter:blur(25px)}
.status{position:absolute;top:24px;left:68px;right:58px;height:49px;display:flex;align-items:center;justify-content:space-between;font-size:29px;font-weight:700}.status-icons{display:flex;align-items:center;gap:11px}.signal{height:21px;display:flex;align-items:end;gap:3px}.signal i{display:block;width:5px;background:#111;border-radius:2px}.signal i:nth-child(1){height:8px}.signal i:nth-child(2){height:13px}.signal i:nth-child(3){height:18px}.signal i:nth-child(4){height:22px}.wifi{font-size:29px;line-height:1}.battery{width:42px;height:20px;border:3px solid #111;border-radius:5px;position:relative}.battery:before{content:"";position:absolute;left:3px;top:3px;width:29px;height:8px;background:#111;border-radius:1px}.battery:after{content:"";position:absolute;right:-6px;top:5px;width:3px;height:7px;background:#111;border-radius:2px}.island{position:absolute;left:262px;top:14px;width:238px;height:64px;border-radius:38px;background:#050506;z-index:4;box-shadow:0 2px 5px #2225}.island:after{content:"";position:absolute;right:23px;top:27px;width:9px;height:9px;border-radius:50%;background:#102c41;box-shadow:0 0 0 2px #07131b}
.header{position:absolute;top:100px;left:24px;right:22px;display:flex;align-items:center;justify-content:space-between}.brand-chip{width:286px;height:90px;display:flex;align-items:center;justify-content:center;border-radius:49px;background:linear-gradient(135deg,#ffffffdb,#ffffff96);border:1px solid #ffffffda;box-shadow:0 8px 22px #473f3717,inset 0 1px 2px #fff}.brand-chip.dark{background:linear-gradient(135deg,#101010,#030303);border-color:#292622;box-shadow:0 8px 22px #473f372a,inset 0 1px 2px #5a4b31}.brand-chip img{max-width:245px;max-height:75px;object-fit:contain}.header-actions{display:flex;gap:11px}.circle{display:flex;align-items:center;justify-content:center;width:89px;height:89px;border-radius:50%;background:linear-gradient(140deg,#ffffffde,#ffffff9e);border:1px solid #fff;box-shadow:0 7px 20px #3e34251a}
.hero-copy{position:absolute;top:320px;left:40px;width:520px}.eyebrow{color:#906b36;font-size:19px;letter-spacing:4.4px;font-weight:600;height:32px}.headline{font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:78px;line-height:1.09;letter-spacing:-3px;margin:14px 0 17px;white-space:nowrap}.description{font-size:26px;line-height:1.27;max-width:365px;margin:0 0 28px;color:#27231f}.cta{display:flex;align-items:center;justify-content:space-between;background:#141414;color:white;border-radius:50px;width:345px;height:75px;padding:0 24px 0 29px;font-size:24px;box-shadow:0 7px 12px #0002}
.categories{position:absolute;left:30px;right:30px;top:780px;height:150px;display:grid;grid-template-columns:repeat(5,1fr);gap:16px}.category{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:18px;height:150px;border-radius:28px;background:linear-gradient(135deg,#ffffffea,#f4eee8ea);box-shadow:0 8px 18px #352b231d,inset 0 0 0 1px #e1d8cd;font-size:20px;white-space:nowrap}.category-icon{height:48px;color:#9c7440}
.announcement{position:absolute;left:30px;right:30px;top:954px;height:231px;border-radius:24px;overflow:hidden;background:linear-gradient(90deg,#ede4dc,#cbb7a5)}.announcement img{position:absolute;right:0;top:0;width:50%;height:100%;object-fit:cover;object-position:center 38%}.announcement-shade{position:absolute;inset:0;background:linear-gradient(90deg,#f0e8e1 0%,#f0e8e1 44%,#f0e8e1af 62%,transparent 100%)}.announcement-copy{position:absolute;left:31px;top:32px;width:425px}.announcement-eyebrow{font-size:17px;letter-spacing:4px;font-weight:600}.announcement-title{font-family:Georgia,'Times New Roman',serif;font-size:55px;line-height:1.05;margin:15px 0 6px;letter-spacing:-1.5px}.announcement-detail{font-size:22px}.announcement-arrow{position:absolute;left:327px;bottom:28px;width:59px;height:59px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:var(--accent);color:white}
.features-heading{position:absolute;left:30px;right:30px;top:1212px;display:flex;align-items:center;justify-content:space-between}.features-heading h2{font-family:Georgia,'Times New Roman',serif;font-size:39px;letter-spacing:-1px;font-weight:400;margin:0}.features-heading span{font-size:21px}.features{position:absolute;left:30px;right:30px;top:1272px;height:252px;display:grid;grid-template-columns:repeat(3,1fr);gap:11px}.feature{position:relative;border-radius:20px;overflow:hidden;background:#c8b5a3}.feature img{width:100%;height:100%;object-fit:cover}.feature-shade{position:absolute;inset:0;background:linear-gradient(180deg,transparent 38%,#000b 100%)}.feature-copy{position:absolute;left:14px;right:10px;bottom:14px;color:white;text-shadow:0 1px 4px #0008}.feature-copy strong{display:block;font-size:22px;font-weight:500;margin-bottom:5px}.feature-copy span{display:block;font-size:17px;line-height:1.14}
.bottom-nav{position:absolute;left:28px;right:28px;bottom:43px;height:128px;display:grid;grid-template-columns:repeat(4,1fr);align-items:stretch;padding:5px;border-radius:71px;background:linear-gradient(135deg,#fffffff5,#f8f5f1ed);border:1px solid #fff;box-shadow:0 8px 24px #4b40322b,inset 0 1px 1px #fff;z-index:8}.nav-item{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:7px;color:#66635f;font-size:19px}.nav-item.active{color:#181716;border-radius:66px;background:linear-gradient(135deg,#fbf5ed,#e9dfd2a8);box-shadow:0 0 25px #bca18220}.nav-item svg{width:39px;height:39px}.home-indicator{position:absolute;left:50%;transform:translateX(-50%);bottom:13px;width:267px;height:8px;border-radius:5px;background:#5a5a5a;z-index:7}
</style></head><body><div class="canvas" style="--accent:${input.brandAccent}"><div class="phone"><div class="screen" data-check="screen"><div class="hero-shadow"></div><img class="hero-photo" src="${images.hero}" alt=""/><div class="hero-wash"></div><div class="status"><span>9:41</span><div class="status-icons"><span class="signal"><i></i><i></i><i></i><i></i></span><span class="wifi">◖</span><span class="battery"></span></div></div><div class="island"></div><div class="header"><div class="brand-chip ${input.logoSurface}"><img src="${images.logo}" alt="${e(input.businessName)} logo"/></div><div class="header-actions"><div class="circle">${icons.search}</div><div class="circle">${icons.bell}</div></div></div><div class="hero-copy" data-check="hero"><div class="eyebrow">${e(input.eyebrow)}</div><h1 class="headline">${e(input.headline[0])}<br/>${e(input.headline[1])}</h1><p class="description">${e(input.description[0])}<br/>${e(input.description[1])}</p><div class="cta">${e(input.cta)}${icons.arrow}</div></div><div class="categories" data-check="categories">${categories}</div><div class="announcement" data-check="announcement"><img src="${images.announcement}" alt=""/><div class="announcement-shade"></div><div class="announcement-copy"><div class="announcement-eyebrow">${e(input.announcementEyebrow)}</div><div class="announcement-title">${e(input.announcementHeadline[0])}<br/>${e(input.announcementHeadline[1])}</div><div class="announcement-detail">${e(input.announcementDetail)}</div></div><div class="announcement-arrow">${icons.arrow}</div></div><div class="features-heading" data-check="features-heading"><h2>${e(input.featuresTitle)}</h2><span>See all →</span></div><div class="features" data-check="features">${features}</div><div class="bottom-nav" data-check="nav"><div class="nav-item active">${icons.home}<span>Home</span></div><div class="nav-item">${icons.calendar}<span>Booking</span></div><div class="nav-item">${icons.community}<span>Community</span></div><div class="nav-item">${icons.account}<span>Account</span></div></div><div class="home-indicator"></div></div></div></div></body></html>`;
}
