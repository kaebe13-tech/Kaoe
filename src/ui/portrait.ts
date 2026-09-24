import type { Agent } from '../agents/Agent';
import { hex } from './dom';

/**
 * A small painted portrait of a person, drawn from their appearance: banner-coloured ground,
 * skin, hair style and colour, garment, headwear, and a crown for leaders.
 */
export function drawPortrait(canvas: HTMLCanvasElement, a: Agent, banner: number, leader: boolean): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const s = canvas.width;
  const k = s / 64;
  g.setTransform(k, 0, 0, k, 0, 0);
  g.clearRect(0, 0, 64, 64);
  const L = a.look;
  // Ground: soft disc in the civ's colour.
  const grad = g.createRadialGradient(32, 26, 4, 32, 32, 34);
  grad.addColorStop(0, shade(banner, 1.25));
  grad.addColorStop(1, shade(banner, 0.55));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(32, 32, 32, 0, Math.PI * 2);
  g.fill();
  g.save();
  g.beginPath();
  g.arc(32, 32, 31, 0, Math.PI * 2);
  g.clip();
  // Shoulders and garment.
  g.fillStyle = hex(L.shirt);
  g.beginPath();
  g.moveTo(8, 66);
  g.quadraticCurveTo(10, 46, 32, 44);
  g.quadraticCurveTo(54, 46, 56, 66);
  g.fill();
  g.fillStyle = hex(L.trim);
  g.fillRect(29, 45, 6, 21);
  if (L.accessory === 2) {
    g.fillStyle = hex(L.trim);
    g.beginPath();
    g.ellipse(32, 46, 13, 4, 0, 0, Math.PI * 2);
    g.fill();
  }
  if (L.accessory === 3) {
    g.strokeStyle = '#e7c46a';
    g.lineWidth = 1.4;
    g.beginPath();
    g.arc(32, 44, 7, 0.15 * Math.PI, 0.85 * Math.PI);
    g.stroke();
  }
  // Neck and head.
  const skin = hex(L.skin);
  g.fillStyle = shade(L.skin, 0.85);
  g.fillRect(28, 36, 8, 9);
  const long = L.hairStyle === 1 || L.hairStyle === 3 || L.hairStyle === 4 || L.hairStyle === 6;
  const hair = hex(L.hair);
  if (long && L.hairStyle !== 3) {
    g.fillStyle = hair;
    g.beginPath();
    g.ellipse(32, 34, 15, 17, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = skin;
  g.beginPath();
  g.ellipse(32, 28, 12, 13.5, 0, 0, Math.PI * 2);
  g.fill();
  // Hair on top.
  if (L.hairStyle !== 5) {
    g.fillStyle = hair;
    g.beginPath();
    g.ellipse(32, 20, 12.6, 8, 0, Math.PI, 0);
    g.lineTo(44.6, 24);
    g.quadraticCurveTo(38, 17, 30, 20);
    g.quadraticCurveTo(24, 22, 19.4, 25);
    g.closePath();
    g.fill();
    if (L.hairStyle === 2) {
      g.beginPath();
      g.arc(32, 11, 5, 0, Math.PI * 2);
      g.fill();
    }
    if (L.hairStyle === 6) {
      for (let i = 0; i < 7; i++) {
        g.beginPath();
        g.arc(21 + i * 3.7, 17 + Math.sin(i) * 1.5, 3.2, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  // Face.
  const eyeY = 29;
  g.fillStyle = '#2a1d16';
  g.beginPath();
  g.ellipse(27.5, eyeY, 1.5, L.face === 2 ? 1.2 : 1.8, 0, 0, Math.PI * 2);
  g.ellipse(36.5, eyeY, 1.5, L.face === 2 ? 1.2 : 1.8, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = shade(L.hair, 0.8);
  g.lineWidth = 1.3;
  g.beginPath();
  const brow = L.face === 1 ? -0.8 : L.face === 3 ? 0.8 : 0;
  g.moveTo(25, eyeY - 4 + brow);
  g.lineTo(30, eyeY - 4.3);
  g.moveTo(34, eyeY - 4.3);
  g.lineTo(39, eyeY - 4 + brow);
  g.stroke();
  g.fillStyle = shade(L.skin, 0.78);
  g.beginPath();
  g.ellipse(32, 32.5, 1.4, 2, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#6b3a2e';
  g.lineWidth = 1.2;
  g.beginPath();
  g.arc(32, 35, 3.2, 0.2 * Math.PI, 0.8 * Math.PI);
  g.stroke();
  if (L.beard) {
    g.fillStyle = hair;
    g.beginPath();
    g.moveTo(21, 31);
    g.quadraticCurveTo(22, 44, 32, 45);
    g.quadraticCurveTo(42, 44, 43, 31);
    g.quadraticCurveTo(38, 38, 32, 38);
    g.quadraticCurveTo(26, 38, 21, 31);
    g.fill();
  }
  // Headwear.
  switch (L.headwear) {
    case 1:
      g.fillStyle = hex(L.shirt);
      g.beginPath();
      g.ellipse(32, 24, 16, 16, 0, Math.PI * 1.02, Math.PI * 1.98);
      g.lineTo(46, 38);
      g.lineTo(42, 38);
      g.quadraticCurveTo(42, 18, 32, 17);
      g.quadraticCurveTo(22, 18, 22, 38);
      g.lineTo(18, 38);
      g.closePath();
      g.fill();
      break;
    case 2:
      g.fillStyle = hex(L.trim);
      g.fillRect(19.5, 19, 25, 4);
      break;
    case 3:
      g.fillStyle = hex(L.trim);
      g.beginPath();
      g.ellipse(32, 17, 13.5, 6.5, 0, Math.PI, 0);
      g.fill();
      break;
    case 4:
      g.fillStyle = hex(L.trim);
      g.fillRect(19.5, 19, 25, 3);
      g.fillStyle = '#e8d8b8';
      g.beginPath();
      g.ellipse(45, 12, 2.4, 8, 0.5, 0, Math.PI * 2);
      g.fill();
      break;
    case 5:
      g.fillStyle = '#d9b867';
      g.beginPath();
      g.ellipse(32, 17, 21, 4.5, 0, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.ellipse(32, 14, 10, 6, 0, Math.PI, 0);
      g.fill();
      break;
    case 6:
      g.strokeStyle = '#e7c46a';
      g.lineWidth = 1.6;
      g.beginPath();
      g.ellipse(32, 19.5, 12.8, 3, 0, 0, Math.PI);
      g.stroke();
      break;
    default:
      break;
  }
  if (leader) {
    g.fillStyle = '#f2c94c';
    g.strokeStyle = '#7a5a12';
    g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(22, 15);
    g.lineTo(22, 8);
    g.lineTo(26.5, 12);
    g.lineTo(32, 5);
    g.lineTo(37.5, 12);
    g.lineTo(42, 8);
    g.lineTo(42, 15);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = '#c0392b';
    g.beginPath();
    g.arc(32, 12, 1.4, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  g.strokeStyle = 'rgba(255,255,255,.35)';
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(32, 32, 31, 0, Math.PI * 2);
  g.stroke();
}

function shade(c: number, k: number): string {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * k));
  const b = Math.min(255, Math.round((c & 255) * k));
  return `rgb(${r},${g},${b})`;
}
