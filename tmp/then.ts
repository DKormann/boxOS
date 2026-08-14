

(async function (){

  console.log("0")
  
  let r = await ({then:(f: (n:number)=>void)=>{


    console.log("A")
    f(22)
  }})

  console.log("B")


  



})()

console.log("C")
  

