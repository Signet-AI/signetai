#pragma once

#include "CoreMinimal.h"
#include "SignetUnrealTypes.generated.h"

UENUM(BlueprintType)
enum class ESignetNpcEventScope : uint8
{
	World UMETA(DisplayName = "World"),
	Player UMETA(DisplayName = "Player")
};

USTRUCT(BlueprintType)
struct SIGNETUNREALRUNTIME_API FSignetOperationResult
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Signet")
	bool bSuccess = false;

	UPROPERTY(BlueprintReadOnly, Category = "Signet")
	int32 StatusCode = 0;

	UPROPERTY(BlueprintReadOnly, Category = "Signet")
	FString Error;

	UPROPERTY(BlueprintReadOnly, Category = "Signet")
	FString ResponseBody;
};

USTRUCT(BlueprintType)
struct SIGNETUNREALRUNTIME_API FSignetNpcIdentity
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	FString AgentId;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	FString WorldId;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	FString DisplayName;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	FString Role;
};

USTRUCT(BlueprintType)
struct SIGNETUNREALRUNTIME_API FSignetNpcEvent
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	FString EventId;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	FString AgentId;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	FString WorldId;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	FString PlayerId;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	FString EventType;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet", meta = (MultiLine = true))
	FString Summary;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet", meta = (MultiLine = true))
	FString Transcript;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet")
	ESignetNpcEventScope Scope = ESignetNpcEventScope::Player;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Signet", meta = (ClampMin = "0.0", ClampMax = "1.0"))
	float Importance = 0.6f;
};

USTRUCT(BlueprintType)
struct SIGNETUNREALRUNTIME_API FSignetMemoryBlock
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Signet")
	FString Id;

	UPROPERTY(BlueprintReadOnly, Category = "Signet")
	FString Content;

	UPROPERTY(BlueprintReadOnly, Category = "Signet")
	FString Type;

	UPROPERTY(BlueprintReadOnly, Category = "Signet")
	FString Source;

	UPROPERTY(BlueprintReadOnly, Category = "Signet")
	FString CreatedAt;

	UPROPERTY(BlueprintReadOnly, Category = "Signet")
	FString Scope;

	UPROPERTY(BlueprintReadOnly, Category = "Signet")
	float Score = 0.0f;
};

USTRUCT(BlueprintType)
struct SIGNETUNREALRUNTIME_API FSignetRecallContext
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Signet")
	FString Query;

	UPROPERTY(BlueprintReadOnly, Category = "Signet", meta = (MultiLine = true))
	FString PromptContext;

	UPROPERTY(BlueprintReadOnly, Category = "Signet")
	TArray<FSignetMemoryBlock> Memories;
};
