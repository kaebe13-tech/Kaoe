import * as THREE from 'three';

// Game State
const gameState = {
    isPlaying: true,
    score: 0,
    tokens: 0,
    speed: 0.2,
    speedIncrement: 0.0001,
    maxSpeed: 0.5
};

// Constants
const LANES = [-3, 0, 3]; // Left, Center, Right lane positions
const LANE_SWITCH_SPEED = 0.3;
const JUMP_VELOCITY = 0.35;
const GRAVITY = 0.02;
const GROUND_Y = 0.5;

// Scene Setup
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x000033, 10, 100);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 4, 5);
camera.lookAt(0, 1, -10);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

// Lighting
const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
directionalLight.position.set(0, 10, 5);
scene.add(directionalLight);

// Neon point lights for cyberpunk effect
const neonLight1 = new THREE.PointLight(0x00ffff, 2, 50);
neonLight1.position.set(-5, 3, -10);
scene.add(neonLight1);

const neonLight2 = new THREE.PointLight(0xff00ff, 2, 50);
neonLight2.position.set(5, 3, -10);
scene.add(neonLight2);

// Player
const playerGeometry = new THREE.BoxGeometry(0.8, 1.2, 0.8);
const playerMaterial = new THREE.MeshStandardMaterial({ 
    color: 0x00ffff,
    emissive: 0x00ffff,
    emissiveIntensity: 0.5,
    metalness: 0.8,
    roughness: 0.2
});
const player = new THREE.Mesh(playerGeometry, playerMaterial);
player.position.set(LANES[1], GROUND_Y, 0);
scene.add(player);

// Player state
const playerState = {
    currentLane: 1,
    targetX: LANES[1],
    velocityY: 0,
    isJumping: false,
    isGrounded: true
};

// Ground/Path
const pathSegments = [];
const SEGMENT_LENGTH = 20;
const SEGMENT_COUNT = 6;

function createPathSegment(zPosition) {
    const group = new THREE.Group();
    
    // Main path
    const pathGeometry = new THREE.PlaneGeometry(10, SEGMENT_LENGTH);
    const pathMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x001133,
        emissive: 0x001133,
        emissiveIntensity: 0.3
    });
    const path = new THREE.Mesh(pathGeometry, pathMaterial);
    path.rotation.x = -Math.PI / 2;
    path.position.y = 0;
    group.add(path);
    
    // Lane lines (neon glowing)
    const lineMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x00ffff,
        emissive: 0x00ffff,
        emissiveIntensity: 1
    });
    
    for (let i = 0; i < 3; i++) {
        for (let z = 0; z < SEGMENT_LENGTH; z += 2) {
            const lineGeometry = new THREE.BoxGeometry(0.1, 0.05, 0.8);
            const line = new THREE.Mesh(lineGeometry, lineMaterial);
            line.position.set(LANES[i], 0.05, -SEGMENT_LENGTH/2 + z);
            group.add(line);
        }
    }
    
    // Side barriers with neon glow
    const barrierMaterial = new THREE.MeshStandardMaterial({ 
        color: 0xff00ff,
        emissive: 0xff00ff,
        emissiveIntensity: 0.8
    });
    
    const leftBarrier = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2, SEGMENT_LENGTH), barrierMaterial);
    leftBarrier.position.set(-6, 1, 0);
    group.add(leftBarrier);
    
    const rightBarrier = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2, SEGMENT_LENGTH), barrierMaterial);
    rightBarrier.position.set(6, 1, 0);
    group.add(rightBarrier);
    
    group.position.z = zPosition;
    return group;
}

// Initialize path segments
for (let i = 0; i < SEGMENT_COUNT; i++) {
    const segment = createPathSegment(-i * SEGMENT_LENGTH);
    pathSegments.push(segment);
    scene.add(segment);
}

// Obstacles
const obstacles = [];
const OBSTACLE_SPAWN_DISTANCE = 30;
let lastObstacleZ = -OBSTACLE_SPAWN_DISTANCE;

function createStaticBarrier(lane, z) {
    const geometry = new THREE.BoxGeometry(0.8, 1.5, 0.8);
    const material = new THREE.MeshStandardMaterial({ 
        color: 0xff0000,
        emissive: 0xff0000,
        emissiveIntensity: 0.7,
        metalness: 0.8,
        roughness: 0.2
    });
    const obstacle = new THREE.Mesh(geometry, material);
    obstacle.position.set(LANES[lane], 0.75, z);
    obstacle.userData = { type: 'barrier', lane };
    return obstacle;
}

function createLowHurdle(lane, z) {
    const geometry = new THREE.BoxGeometry(0.8, 0.6, 0.8);
    const material = new THREE.MeshStandardMaterial({ 
        color: 0xffff00,
        emissive: 0xffff00,
        emissiveIntensity: 0.7,
        metalness: 0.8,
        roughness: 0.2
    });
    const obstacle = new THREE.Mesh(geometry, material);
    obstacle.position.set(LANES[lane], 0.3, z);
    obstacle.userData = { type: 'hurdle', lane };
    return obstacle;
}

function createMovingObstacle(lane, z) {
    const geometry = new THREE.SphereGeometry(0.5, 16, 16);
    const material = new THREE.MeshStandardMaterial({ 
        color: 0xff00ff,
        emissive: 0xff00ff,
        emissiveIntensity: 0.9,
        metalness: 1,
        roughness: 0
    });
    const obstacle = new THREE.Mesh(geometry, material);
    obstacle.position.set(LANES[lane], 0.5, z);
    obstacle.userData = { type: 'moving', lane, direction: 1 };
    return obstacle;
}

function spawnObstacle() {
    const spawnZ = lastObstacleZ - OBSTACLE_SPAWN_DISTANCE;
    
    // Randomly choose how many lanes to block (always leave at least one clear)
    const blockedLanes = [];
    const numToBlock = Math.random() < 0.5 ? 1 : 2;
    
    while (blockedLanes.length < numToBlock) {
        const lane = Math.floor(Math.random() * 3);
        if (!blockedLanes.includes(lane)) {
            blockedLanes.push(lane);
        }
    }
    
    // Create obstacles in blocked lanes
    blockedLanes.forEach(lane => {
        const obstacleType = Math.random();
        let obstacle;
        
        if (obstacleType < 0.4) {
            obstacle = createStaticBarrier(lane, spawnZ);
        } else if (obstacleType < 0.7) {
            obstacle = createLowHurdle(lane, spawnZ);
        } else {
            obstacle = createMovingObstacle(lane, spawnZ);
        }
        
        obstacles.push(obstacle);
        scene.add(obstacle);
    });
    
    lastObstacleZ = spawnZ;
}

// Collectible Tokens
const tokens = [];
const TOKEN_SPAWN_DISTANCE = 15;
let lastTokenZ = -TOKEN_SPAWN_DISTANCE;

function createToken(x, y, z) {
    const geometry = new THREE.OctahedronGeometry(0.3);
    const material = new THREE.MeshStandardMaterial({ 
        color: 0xffff00,
        emissive: 0xffff00,
        emissiveIntensity: 1,
        metalness: 1,
        roughness: 0
    });
    const token = new THREE.Mesh(geometry, material);
    token.position.set(x, y, z);
    token.userData = { collected: false, rotationSpeed: 0.05 };
    return token;
}

function spawnTokens() {
    const spawnZ = lastTokenZ - TOKEN_SPAWN_DISTANCE;
    
    // Random token arrangement
    const arrangement = Math.random();
    
    if (arrangement < 0.4) {
        // Single lane tokens
        const lane = Math.floor(Math.random() * 3);
        const token = createToken(LANES[lane], 1, spawnZ);
        tokens.push(token);
        scene.add(token);
    } else if (arrangement < 0.7) {
        // All lanes
        for (let i = 0; i < 3; i++) {
            const token = createToken(LANES[i], 1, spawnZ);
            tokens.push(token);
            scene.add(token);
        }
    } else {
        // Arc pattern requiring jump
        const lane = Math.floor(Math.random() * 3);
        for (let i = 0; i < 5; i++) {
            const height = 1 + Math.sin(i * Math.PI / 4) * 1.5;
            const token = createToken(LANES[lane], height, spawnZ - i * 1.5);
            tokens.push(token);
            scene.add(token);
        }
    }
    
    lastTokenZ = spawnZ;
}

// Input Handling
const keys = {};

window.addEventListener('keydown', (e) => {
    keys[e.key.toLowerCase()] = true;
    
    if (gameState.isPlaying) {
        // Lane switching
        if ((e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a') && playerState.currentLane > 0) {
            playerState.currentLane--;
            playerState.targetX = LANES[playerState.currentLane];
        }
        if ((e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') && playerState.currentLane < 2) {
            playerState.currentLane++;
            playerState.targetX = LANES[playerState.currentLane];
        }
        
        // Jumping
        if ((e.key === 'ArrowUp' || e.key.toLowerCase() === 'w' || e.key === ' ') && playerState.isGrounded) {
            playerState.velocityY = JUMP_VELOCITY;
            playerState.isJumping = true;
            playerState.isGrounded = false;
        }
    }
});

window.addEventListener('keyup', (e) => {
    keys[e.key.toLowerCase()] = false;
});

// Collision Detection
function checkCollision(obj1, obj2, tolerance = 0.8) {
    const distance = obj1.position.distanceTo(obj2.position);
    return distance < tolerance;
}

function checkObstacleCollisions() {
    for (let obstacle of obstacles) {
        if (obstacle.position.z > player.position.z - 2 && 
            obstacle.position.z < player.position.z + 2) {
            
            if (obstacle.userData.type === 'hurdle') {
                // Must jump over hurdles
                if (checkCollision(player, obstacle, 0.8) && player.position.y <= 1.5) {
                    gameOver();
                    return;
                }
            } else {
                // Must avoid barriers and moving obstacles by lane switching
                if (checkCollision(player, obstacle, 0.9)) {
                    gameOver();
                    return;
                }
            }
        }
    }
}

function checkTokenCollisions() {
    for (let token of tokens) {
        if (!token.userData.collected && checkCollision(player, token, 1.2)) {
            token.userData.collected = true;
            scene.remove(token);
            gameState.tokens++;
            document.getElementById('tokenValue').textContent = gameState.tokens;
        }
    }
}

// Game Over
function gameOver() {
    gameState.isPlaying = false;
    document.getElementById('finalScore').textContent = Math.floor(gameState.score);
    document.getElementById('finalTokens').textContent = gameState.tokens;
    document.getElementById('gameOver').style.display = 'block';
}

// Restart
document.getElementById('restartBtn').addEventListener('click', () => {
    location.reload();
});

// Animation Loop
function animate() {
    requestAnimationFrame(animate);
    
    if (gameState.isPlaying) {
        // Update score
        gameState.score += gameState.speed * 10;
        document.getElementById('scoreValue').textContent = Math.floor(gameState.score);
        
        // Increase speed gradually
        if (gameState.speed < gameState.maxSpeed) {
            gameState.speed += gameState.speedIncrement;
        }
        
        // Move path segments
        pathSegments.forEach(segment => {
            segment.position.z += gameState.speed;
            if (segment.position.z > SEGMENT_LENGTH) {
                segment.position.z -= SEGMENT_LENGTH * SEGMENT_COUNT;
            }
        });
        
        // Update player lane position (smooth lane switching)
        if (Math.abs(player.position.x - playerState.targetX) > 0.1) {
            const direction = playerState.targetX > player.position.x ? 1 : -1;
            player.position.x += direction * LANE_SWITCH_SPEED;
        } else {
            player.position.x = playerState.targetX;
        }
        
        // Update player jump physics
        if (!playerState.isGrounded) {
            playerState.velocityY -= GRAVITY;
            player.position.y += playerState.velocityY;
            
            if (player.position.y <= GROUND_Y) {
                player.position.y = GROUND_Y;
                playerState.velocityY = 0;
                playerState.isGrounded = true;
                playerState.isJumping = false;
            }
        }
        
        // Update obstacles
        obstacles.forEach((obstacle, index) => {
            obstacle.position.z += gameState.speed;
            
            // Moving obstacles
            if (obstacle.userData.type === 'moving') {
                obstacle.userData.direction *= (obstacle.position.z % 5 < 0.1) ? -1 : 1;
                obstacle.position.x += obstacle.userData.direction * 0.05;
            }
            
            // Remove obstacles that passed the player
            if (obstacle.position.z > 10) {
                scene.remove(obstacle);
                obstacles.splice(index, 1);
            }
        });
        
        // Update tokens
        tokens.forEach((token, index) => {
            if (!token.userData.collected) {
                token.position.z += gameState.speed;
                token.rotation.y += token.userData.rotationSpeed;
                token.rotation.x += token.userData.rotationSpeed * 0.5;
                
                // Remove tokens that passed the player
                if (token.position.z > 10) {
                    scene.remove(token);
                    tokens.splice(index, 1);
                }
            }
        });
        
        // Spawn new obstacles
        if (player.position.z - lastObstacleZ > OBSTACLE_SPAWN_DISTANCE - 10) {
            spawnObstacle();
        }
        
        // Spawn new tokens
        if (player.position.z - lastTokenZ > TOKEN_SPAWN_DISTANCE - 10) {
            spawnTokens();
        }
        
        // Check collisions
        checkObstacleCollisions();
        checkTokenCollisions();
        
        // Animate neon lights
        neonLight1.position.z = player.position.z - 10;
        neonLight2.position.z = player.position.z - 10;
        
        // Camera follows player
        camera.position.z = player.position.z + 5;
        camera.lookAt(player.position.x, player.position.y + 1, player.position.z - 10);
    }
    
    renderer.render(scene, camera);
}

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Start the game
animate();
