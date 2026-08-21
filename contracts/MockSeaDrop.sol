// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockSeaDrop — minimal replica of SeaDrop v1.5 for testnet testing
/// @notice Implements the exact same function signatures the bot calls:
///         getPublicDrop, getAllowedFeeRecipients, mintPublic
/// @dev    Deploy to Arbitrum Sepolia, then pass the NFT contract address to the bot.

contract MockNFT {
    string public name = "Test SeaDrop NFT";
    string public symbol = "TSNFT";
    uint256 private _tokenIdCounter;

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public mintedPerWallet;

    uint256 public constant MINT_PRICE = 0.001 ether;
    uint256 public constant MAX_PER_WALLET = 5;
    uint48 public constant START_TIME = 0;      // active immediately
    uint48 public constant END_TIME = type(uint48).max;
    uint16 public constant FEE_BPS = 500;       // 5% fee

    address public feeRecipient;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    constructor() {
        feeRecipient = msg.sender;
    }

    /// @notice Mint NFTs — mirrors SeaDrop.mintPublic() signature
    function mintPublic(
        address nftContract,
        address _feeRecipient,
        address minterIfNotPayer,
        uint256 quantity
    ) external payable {
        require(msg.value >= MINT_PRICE * quantity, "Insufficient payment");
        require(mintedPerWallet[msg.sender] + quantity <= MAX_PER_WALLET, "Exceeds wallet limit");

        // Send fee to recipient
        uint256 fee = (msg.value * FEE_BPS) / 10000;
        if (fee > 0 && _feeRecipient != address(0)) {
            (bool sent, ) = _feeRecipient.call{value: fee}("");
            require(sent, "Fee transfer failed");
        }

        // Refund excess
        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool sent, ) = msg.sender.call{value: refund}("");
            require(sent, "Refund failed");
        }

        // Mint tokens
        address recipient = minterIfNotPayer == address(0) ? msg.sender : minterIfNotPayer;
        mintedPerWallet[msg.sender] += quantity;

        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = _tokenIdCounter++;
            ownerOf[tokenId] = recipient;
            emit Transfer(address(0), recipient, tokenId);
        }
    }

    /// @notice Allow the owner to withdraw collected fees
    function withdraw() external {
        (bool sent, ) = feeRecipient.call{value: address(this).balance}("");
        require(sent, "Withdraw failed");
    }
}

/// @title MockSeaDrop — pretends to be the SeaDrop singleton
/// @dev    The bot calls this address for getPublicDrop + getAllowedFeeRecipients
contract MockSeaDrop {
    struct PublicDrop {
        uint80 mintPrice;
        uint48 startTime;
        uint48 endTime;
        uint16 maxTotalMintableByWallet;
        uint16 feeBps;
        bool restrictFeeRecipients;
    }

    // NFT contract address => drop config
    mapping(address => PublicDrop) internal _drops;
    // NFT contract address => allowed fee recipients
    mapping(address => address[]) internal _feeRecipients;

    /// @notice Register a mock drop (call this after deploying MockNFT)
    function registerDrop(
        address nftContract,
        uint80 mintPrice,
        uint48 startTime,
        uint48 endTime,
        uint16 maxTotalMintableByWallet,
        uint16 feeBps,
        bool restrictFeeRecipients,
        address[] calldata allowedFeeRecipients
    ) external {
        _drops[nftContract] = PublicDrop({
            mintPrice: mintPrice,
            startTime: startTime,
            endTime: endTime,
            maxTotalMintableByWallet: maxTotalMintableByWallet,
            feeBps: feeBps,
            restrictFeeRecipients: restrictFeeRecipients
        });
        _feeRecipients[nftContract] = allowedFeeRecipients;
    }

    /// @notice Returns the public drop config — exact same signature the bot calls
    function getPublicDrop(address nftContract) external view returns (PublicDrop memory) {
        return _drops[nftContract];
    }

    /// @notice Returns allowed fee recipients — exact same signature the bot calls
    function getAllowedFeeRecipients(address nftContract) external view returns (address[] memory) {
        return _feeRecipients[nftContract];
    }
}
