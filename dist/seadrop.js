"use strict";
// SeaDrop public-mint calldata builder — no OpenSea involvement.
// Adapted from morsyxbt/nft-public-mint for the Telegram bot interface.
// Public stages are unsigned: SeaDrop.mintPublic() takes only the drop's own
// parameters, so the whole transaction can be assembled from on-chain reads.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEADROP_ADDRESS = void 0;
exports.fetchPublicDrop = fetchPublicDrop;
exports.resolveFeeRecipient = resolveFeeRecipient;
exports.encodeMintPublic = encodeMintPublic;
exports.buildMintPlan = buildMintPlan;
const ethers_1 = require("ethers");
// SeaDrop v1.5 singleton (used on mainnets and testnets)
exports.SEADROP_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
// OpenSea's default fee collector for unrestricted drops
const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
const PUBLIC_ABI = [
    "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
    "function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))",
    "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
];
const IFACE = new ethers_1.Interface(PUBLIC_ABI);
async function fetchPublicDrop(rpcUrl, nftContract) {
    const provider = new ethers_1.JsonRpcProvider(rpcUrl);
    const seadrop = new ethers_1.Contract(exports.SEADROP_ADDRESS, PUBLIC_ABI, provider);
    try {
        const raw = await seadrop.getPublicDrop(nftContract);
        const drop = {
            mintPrice: BigInt(raw.mintPrice),
            startTime: Number(raw.startTime),
            endTime: Number(raw.endTime),
            maxTotalMintableByWallet: Number(raw.maxTotalMintableByWallet),
            feeBps: Number(raw.feeBps),
            restrictFeeRecipients: Boolean(raw.restrictFeeRecipients),
        };
        // Unset mapping entry decodes to all zeros
        if (drop.startTime === 0 && drop.endTime === 0 && drop.maxTotalMintableByWallet === 0) {
            return null;
        }
        return drop;
    }
    catch {
        return null;
    }
}
async function resolveFeeRecipient(rpcUrl, nftContract, restricted) {
    const provider = new ethers_1.JsonRpcProvider(rpcUrl);
    const seadrop = new ethers_1.Contract(exports.SEADROP_ADDRESS, PUBLIC_ABI, provider);
    let allowed = [];
    try {
        allowed = await seadrop.getAllowedFeeRecipients(nftContract);
    }
    catch {
        allowed = [];
    }
    if (allowed.length > 0) {
        return { address: allowed[0], source: "allowed fee recipient on-chain" };
    }
    if (restricted) {
        return null;
    }
    return { address: OPENSEA_FEE_RECIPIENT, source: "OpenSea default (drop does not restrict)" };
}
function encodeMintPublic(nftContract, feeRecipient, quantity) {
    return IFACE.encodeFunctionData("mintPublic", [
        nftContract,
        feeRecipient,
        "0x0000000000000000000000000000000000000000",
        BigInt(quantity),
    ]);
}
async function buildMintPlan(rpcUrl, nftContract, quantity) {
    const drop = await fetchPublicDrop(rpcUrl, nftContract);
    if (!drop)
        return null;
    const fee = await resolveFeeRecipient(rpcUrl, nftContract, drop.restrictFeeRecipients);
    if (!fee)
        return null;
    return {
        to: exports.SEADROP_ADDRESS,
        data: encodeMintPublic(nftContract, fee.address, quantity),
        value: drop.mintPrice * BigInt(quantity),
        drop,
        feeRecipient: fee.address,
    };
}
//# sourceMappingURL=seadrop.js.map